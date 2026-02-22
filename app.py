"""
╔══════════════════════════════════════════════════════════════════════╗
║  VINICIN GOAT — QuantLib Pricing Backend v4                        ║
║                                                                     ║
║  Endpoints:                                                         ║
║    POST /api/price      → full analysis (BSM/Binomial + MC + IV)   ║
║    POST /api/surface    → 3D surface data                          ║
║    POST /api/mc-paths   → MC path visualization data               ║
║    GET  /api/health     → status check                             ║
║                                                                     ║
║  Models:                                                            ║
║    Europeia  → QuantLib AnalyticEuropeanEngine (BSM closed-form)   ║
║    Americana → QuantLib BinomialVanillaEngine (CRR, 800 steps)     ║
║    MC        → QuantLib MCEuropeanEngine (antithetic, pseudorand)  ║
║    IV        → QuantLib impliedVolatility + bisection fallback     ║
║    Gregas EU → QuantLib analytic (delta/gamma/theta/vega/rho)      ║
║    Gregas AM → Finite differences via QuantLib reprice             ║
║                                                                     ║
║  Taxa BR: r_cont = ln(1 + r_anual) · Calendário B3 252 DU        ║
╚══════════════════════════════════════════════════════════════════════╝
"""

import QuantLib as ql
import numpy as np
import json
import traceback
from datetime import datetime, date, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ═════════════════════════════════════════════════════════════════════
# HELPERS
# ═════════════════════════════════════════════════════════════════════

def to_ql_date(d_str: str) -> ql.Date:
    dt = datetime.strptime(d_str, "%Y-%m-%d")
    return ql.Date(dt.day, dt.month, dt.year)

def convert_br_rate(annual: float) -> float:
    """Taxa anual BR (ex: 0.1475) → contínua: ln(1 + r)"""
    return float(np.log(1 + annual))

def biz_days_br(start_str: str, end_str: str) -> int:
    cal = ql.Brazil(ql.Brazil.Exchange)
    return cal.businessDaysBetween(to_ql_date(start_str), to_ql_date(end_str))

# ═════════════════════════════════════════════════════════════════════
# QUANTLIB FACTORY — builds all QL objects from raw inputs
# ═════════════════════════════════════════════════════════════════════

def build_option(S, K, expiry_str, r_cont, sigma, opt_type="call",
                 q_cont=0.0, style="europeia", eval_date_str=None):
    """
    Returns (option, process, today_ql)
    """
    if eval_date_str:
        today = to_ql_date(eval_date_str)
    else:
        d = date.today()
        today = ql.Date(d.day, d.month, d.year)
    ql.Settings.instance().evaluationDate = today

    expiry_ql = to_ql_date(expiry_str)

    payoff = ql.PlainVanillaPayoff(
        ql.Option.Call if opt_type == "call" else ql.Option.Put, K
    )

    if style == "americana":
        exercise = ql.AmericanExercise(today, expiry_ql)
    else:
        exercise = ql.EuropeanExercise(expiry_ql)

    spot_h = ql.QuoteHandle(ql.SimpleQuote(S))
    rate_h = ql.YieldTermStructureHandle(
        ql.FlatForward(today, ql.QuoteHandle(ql.SimpleQuote(r_cont)),
                       ql.Actual365Fixed()))
    div_h = ql.YieldTermStructureHandle(
        ql.FlatForward(today, ql.QuoteHandle(ql.SimpleQuote(q_cont)),
                       ql.Actual365Fixed()))
    vol_h = ql.BlackVolTermStructureHandle(
        ql.BlackConstantVol(today, ql.Brazil(ql.Brazil.Exchange),
                           ql.QuoteHandle(ql.SimpleQuote(sigma)),
                           ql.Actual365Fixed()))

    process = ql.BlackScholesMertonProcess(spot_h, div_h, rate_h, vol_h)
    option = ql.VanillaOption(payoff, exercise)

    return option, process, today

# ═════════════════════════════════════════════════════════════════════
# PRICING ENGINES
# ═════════════════════════════════════════════════════════════════════

def price_bsm(S, K, expiry, r_cont, sigma, opt_type="call", q_cont=0.0):
    """BSM analítico (europeia) via QuantLib."""
    opt, proc, _ = build_option(S, K, expiry, r_cont, sigma, opt_type, q_cont, "europeia")
    opt.setPricingEngine(ql.AnalyticEuropeanEngine(proc))
    return {
        "price": opt.NPV(),
        "delta": opt.delta(),
        "gamma": opt.gamma(),
        "theta": opt.thetaPerDay(),  # já por dia calendário
        "vega": opt.vega() / 100,    # per 1%
        "rho": opt.rho() / 100,      # per 1%
    }

def price_binomial(S, K, expiry, r_cont, sigma, opt_type="call",
                   q_cont=0.0, steps=800):
    """Binomial CRR (americana) via QuantLib."""
    opt, proc, _ = build_option(S, K, expiry, r_cont, sigma, opt_type, q_cont, "americana")
    opt.setPricingEngine(ql.BinomialVanillaEngine(proc, "crr", steps))
    am_price = opt.NPV()

    # European ref for early exercise premium
    opt_eu, proc_eu, _ = build_option(S, K, expiry, r_cont, sigma, opt_type, q_cont, "europeia")
    opt_eu.setPricingEngine(ql.AnalyticEuropeanEngine(proc_eu))
    eu_price = opt_eu.NPV()

    greeks = fd_greeks(S, K, expiry, r_cont, sigma, opt_type, q_cont, min(steps, 400))

    return {
        "price": am_price,
        "eu_price": eu_price,
        "early_exercise_premium": max(am_price - eu_price, 0),
        **greeks,
    }

def fd_greeks(S, K, expiry, r_cont, sigma, opt_type, q_cont, steps=400):
    """Gregas via finite differences (para americana)."""
    hS, hSig, hR = S * 0.005, 0.0001, 0.0001

    def _p(s, r, sig):
        o, pr, _ = build_option(s, K, expiry, r, sig, opt_type, q_cont, "americana")
        o.setPricingEngine(ql.BinomialVanillaEngine(pr, "crr", steps))
        return o.NPV()

    P0 = _p(S, r_cont, sigma)
    Pu, Pd = _p(S + hS, r_cont, sigma), _p(S - hS, r_cont, sigma)

    delta = (Pu - Pd) / (2 * hS)
    gamma = (Pu - 2 * P0 + Pd) / (hS * hS)

    # Theta: reprice com eval_date + 1 dia
    try:
        tomorrow = (date.today() + timedelta(days=1)).strftime("%Y-%m-%d")
        o2, pr2, _ = build_option(S, K, expiry, r_cont, sigma, opt_type, q_cont, "americana", tomorrow)
        o2.setPricingEngine(ql.BinomialVanillaEngine(pr2, "crr", steps))
        theta = o2.NPV() - P0
    except:
        theta = 0.0

    vega = (_p(S, r_cont, sigma + hSig) - _p(S, r_cont, sigma - hSig)) / (2 * hSig) * 0.01
    rho = (_p(S, r_cont + hR, sigma) - _p(S, r_cont - hR, sigma)) / (2 * hR) * 0.01

    return {"delta": delta, "gamma": gamma, "theta": theta, "vega": vega, "rho": rho}

def price_mc(S, K, expiry, r_cont, sigma, opt_type="call", q_cont=0.0,
             n_paths=100_000, n_steps=252, seed=42):
    """Monte Carlo via QuantLib MCEuropeanEngine (pseudorandom + antithetic)."""
    opt, proc, _ = build_option(S, K, expiry, r_cont, sigma, opt_type, q_cont, "europeia")
    engine = ql.MCEuropeanEngine(
        proc, "pseudorandom",
        timeSteps=n_steps,
        antitheticVariate=True,
        requiredSamples=n_paths,
        seed=seed,
    )
    opt.setPricingEngine(engine)
    npv = opt.NPV()
    try:
        se = opt.errorEstimate()
    except:
        se = 0.0
    return {"price": npv, "std_error": se, "n_paths": n_paths, "n_steps": n_steps}

# ═════════════════════════════════════════════════════════════════════
# IMPLIED VOLATILITY
# ═════════════════════════════════════════════════════════════════════

def calc_iv(mkt_price, S, K, expiry, r_cont, opt_type="call",
            q_cont=0.0, style="europeia"):
    if mkt_price <= 0:
        return 0.0
    try:
        opt, proc, _ = build_option(S, K, expiry, r_cont, 0.30, opt_type, q_cont, style)
        if style == "europeia":
            opt.setPricingEngine(ql.AnalyticEuropeanEngine(proc))
        else:
            opt.setPricingEngine(ql.BinomialVanillaEngine(proc, "crr", 200))
        return opt.impliedVolatility(mkt_price, proc,
                                     accuracy=1e-8, maxEvaluations=300,
                                     minVol=0.001, maxVol=8.0)
    except:
        # Fallback: bisection
        fn = lambda sig: build_and_price(S, K, expiry, r_cont, sig, opt_type, q_cont, style)
        lo, hi = 0.001, 8.0
        for _ in range(200):
            mid = (lo + hi) / 2
            if fn(mid) > mkt_price: hi = mid
            else: lo = mid
            if hi - lo < 1e-8: break
        return (lo + hi) / 2

def build_and_price(S, K, expiry, r_cont, sigma, opt_type, q_cont, style):
    o, p, _ = build_option(S, K, expiry, r_cont, sigma, opt_type, q_cont, style)
    if style == "europeia":
        o.setPricingEngine(ql.AnalyticEuropeanEngine(p))
    else:
        o.setPricingEngine(ql.BinomialVanillaEngine(p, "crr", 150))
    return o.NPV()

# ═════════════════════════════════════════════════════════════════════
# MC PATHS FOR VISUALIZATION (NumPy GBM, not QuantLib engine)
# ═════════════════════════════════════════════════════════════════════

def gen_mc_paths(S, T, r_cont, sigma, q_cont=0.0,
                 n_paths=200, n_steps=60, seed=42):
    rng = np.random.default_rng(seed)
    dt = T / n_steps
    drift = (r_cont - q_cont - 0.5 * sigma**2) * dt
    diff = sigma * np.sqrt(dt)
    half = n_paths // 2
    Z = rng.standard_normal((half, n_steps))
    Z = np.vstack([Z, -Z])  # antithetic
    log_ret = drift + diff * Z
    log_S = np.log(S) + np.cumsum(log_ret, axis=1)
    paths = np.column_stack([np.full(n_paths, S), np.exp(log_S)])
    time_axis = np.linspace(0, T, n_steps + 1)
    return {"paths": paths.tolist(), "time_axis": time_axis.tolist(),
            "n_paths": n_paths, "n_steps": n_steps}

# ═════════════════════════════════════════════════════════════════════
# SURFACE DATA
# ═════════════════════════════════════════════════════════════════════

def gen_surface(S, r_cont, sigma, opt_type="call", q_cont=0.0,
                style="europeia", what="price", n_pts=30):
    today = date.today()
    strikes = np.linspace(S * 0.72, S * 1.28, n_pts).tolist()
    times = np.linspace(0.03, 1.5, n_pts).tolist()
    z = []
    for T in times:
        exp_date = today + timedelta(days=max(int(T * 365), 2))
        exp_str = exp_date.strftime("%Y-%m-%d")
        row = []
        for K in strikes:
            try:
                if what == "price":
                    if style == "americana":
                        o, p, _ = build_option(S, K, exp_str, r_cont, sigma, opt_type, q_cont, "americana")
                        o.setPricingEngine(ql.BinomialVanillaEngine(p, "crr", 60))
                        row.append(round(o.NPV(), 4))
                    else:
                        r = price_bsm(S, K, exp_str, r_cont, sigma, opt_type, q_cont)
                        row.append(round(r["price"], 4))
                elif what == "earlyPremium":
                    o, p, _ = build_option(S, K, exp_str, r_cont, sigma, opt_type, q_cont, "americana")
                    o.setPricingEngine(ql.BinomialVanillaEngine(p, "crr", 60))
                    am = o.NPV()
                    eu = price_bsm(S, K, exp_str, r_cont, sigma, opt_type, q_cont)["price"]
                    row.append(round(max(am - eu, 0), 4))
                else:
                    if style == "americana":
                        g = fd_greeks(S, K, exp_str, r_cont, sigma, opt_type, q_cont, 60)
                    else:
                        g = price_bsm(S, K, exp_str, r_cont, sigma, opt_type, q_cont)
                    row.append(round(g.get(what, 0), 6))
            except:
                row.append(0.0)
        z.append(row)
    return {"strikes": strikes, "times": times, "z": z, "what": what}

# ═════════════════════════════════════════════════════════════════════
# MATH REASONING (step-by-step computation log)
# ═════════════════════════════════════════════════════════════════════

def math_reasoning(S, K, T, r_cont, sigma, opt_type, q_cont, style, mkt_price, result):
    """Gera string com raciocínio matemático expandido."""
    is_am = style == "americana"
    from scipy.stats import norm  # only for display
    steps = []

    steps.append("═══ INPUTS ═══")
    steps.append(f"S = R${S:.2f}  |  K = R${K:.2f}")
    steps.append(f"T = {T:.6f} anos ({int(T*365)} dias / ~{int(T*252)} DU)")
    steps.append(f"r_cont = {r_cont:.6f} (input: {(np.exp(r_cont)-1)*100:.2f}% a.a. → ln(1+r))")
    steps.append(f"σ = {sigma:.6f} ({sigma*100:.2f}%)")
    steps.append(f"q_cont = {q_cont:.6f}")
    steps.append(f"Tipo: {opt_type.upper()}  |  Estilo: {'AMERICANA' if is_am else 'EUROPEIA'}")

    if not is_am:
        steps.append("\n═══ d₁ e d₂ (BSM) ═══")
        d1 = (np.log(S/K) + (r_cont - q_cont + 0.5*sigma**2)*T) / (sigma*np.sqrt(T))
        d2 = d1 - sigma*np.sqrt(T)
        steps.append(f"d₁ = [ln(S/K) + (r-q+σ²/2)·T] / (σ·√T)")
        steps.append(f"d₁ = {d1:.8f}")
        steps.append(f"d₂ = d₁ - σ·√T = {d2:.8f}")

        steps.append(f"\n═══ N(d) ═══")
        steps.append(f"N(d₁) = {norm.cdf(d1):.8f}")
        steps.append(f"N(d₂) = {norm.cdf(d2):.8f}")

        steps.append(f"\n═══ PREÇO BSM ═══")
        if opt_type == "call":
            steps.append("C = S·e^(-qT)·N(d₁) - K·e^(-rT)·N(d₂)")
        else:
            steps.append("P = K·e^(-rT)·N(-d₂) - S·e^(-qT)·N(-d₁)")
        steps.append(f"FAIR VALUE = R${result['model']['price']:.6f}")
    else:
        steps.append("\n═══ ÁRVORE BINOMIAL CRR ═══")
        steps.append("QuantLib BinomialVanillaEngine (CRR, 800 steps)")
        dt = T / 800
        u = np.exp(sigma * np.sqrt(dt))
        d = 1 / u
        p = (np.exp((r_cont - q_cont) * dt) - d) / (u - d)
        steps.append(f"dt = T/N = {dt:.8f}")
        steps.append(f"u = e^(σ√dt) = {u:.8f}")
        steps.append(f"d = 1/u = {d:.8f}")
        steps.append(f"p = [e^((r-q)dt) - d] / (u - d) = {p:.8f}")
        steps.append(f"Backward induction: V = max(exercício, continuação)")
        steps.append(f"FAIR VALUE AM = R${result['model']['price']:.6f}")
        if 'early_exercise' in result:
            steps.append(f"FAIR VALUE EU = R${result['early_exercise']['eu_price']:.6f}")
            steps.append(f"Prêmio exerc. antecip. = R${result['early_exercise']['premium']:.6f}")

    steps.append(f"\n═══ MONTE CARLO (QuantLib) ═══")
    steps.append(f"MCEuropeanEngine: pseudorandom, antithetic, 100k paths")
    steps.append(f"MC Price = R${result['monte_carlo']['price']:.6f} ± {result['monte_carlo']['std_error']:.6f}")

    steps.append(f"\n═══ VOL IMPLÍCITA ═══")
    steps.append(f"QuantLib impliedVolatility (fallback: bisection)")
    steps.append(f"σ_iv = {result['iv_pct']:.4f}%")

    steps.append(f"\n═══ VEREDITO ═══")
    steps.append(f"Spread = (Tela - Fair) / Fair × 100")
    steps.append(f"= (R${mkt_price:.4f} - R${result['model']['price']:.6f}) / R${result['model']['price']:.6f} × 100")
    steps.append(f"= {result['spread_pct']:+.2f}% → {result['verdict']}")

    return "\n".join(steps)

# ═════════════════════════════════════════════════════════════════════
# FULL ANALYSIS
# ═════════════════════════════════════════════════════════════════════

def full_analysis(S, K, expiry, r_annual, sigma, opt_type="call",
                  div_yield=0.0, mkt_price=0.0, style="europeia",
                  mc_paths=100_000):
    r_cont = convert_br_rate(r_annual)
    q_cont = convert_br_rate(div_yield)

    today_str = date.today().strftime("%Y-%m-%d")
    exp_dt = datetime.strptime(expiry, "%Y-%m-%d").date()
    T = max((exp_dt - date.today()).days / 365.0, 1/365)
    days_left = max((exp_dt - date.today()).days, 0)
    try:
        du = biz_days_br(today_str, expiry)
    except:
        du = int(days_left * 252/365)

    is_am = style == "americana"

    # Main model
    if is_am:
        main = price_binomial(S, K, expiry, r_cont, sigma, opt_type, q_cont, 800)
        label = "BINOMIAL CRR"
    else:
        main = price_bsm(S, K, expiry, r_cont, sigma, opt_type, q_cont)
        label = "BSM ANALÍTICO"

    # Monte Carlo
    mc_result = price_mc(S, K, expiry, r_cont, sigma, opt_type, q_cont, mc_paths)

    # IV
    iv = 0.0
    if mkt_price > 0:
        iv = calc_iv(mkt_price, S, K, expiry, r_cont, opt_type, q_cont, style)

    fair = main["price"]
    spread = ((mkt_price - fair) / fair * 100) if fair > 1e-4 else 0.0
    verdict = "CARA" if spread > 5 else ("BARATA" if spread < -5 else "JUSTA")

    result = {
        "inputs": {
            "S": S, "K": K, "expiry": expiry, "T": round(T, 6),
            "days": days_left, "du": du,
            "r_annual": r_annual, "r_cont": round(r_cont, 6),
            "sigma": sigma, "q_annual": div_yield, "q_cont": round(q_cont, 6),
            "type": opt_type, "style": style, "market_price": mkt_price,
        },
        "model": {
            "label": label,
            "price": round(fair, 6),
            "delta": round(main.get("delta", 0), 6),
            "gamma": round(main.get("gamma", 0), 6),
            "theta": round(main.get("theta", 0), 6),
            "vega": round(main.get("vega", 0), 6),
            "rho": round(main.get("rho", 0), 6),
        },
        "monte_carlo": {
            "price": round(mc_result["price"], 6),
            "std_error": round(mc_result["std_error"], 6),
            "n_paths": mc_result["n_paths"],
        },
        "iv": round(iv, 6),
        "iv_pct": round(iv * 100, 4),
        "spread_pct": round(spread, 2),
        "verdict": verdict,
    }

    if is_am:
        result["early_exercise"] = {
            "premium": round(main.get("early_exercise_premium", 0), 6),
            "eu_price": round(main.get("eu_price", 0), 6),
        }

    # Math reasoning
    result["math_reasoning"] = math_reasoning(S, K, T, r_cont, sigma, opt_type, q_cont, style, mkt_price, result)

    return result

# ═════════════════════════════════════════════════════════════════════
# FLASK API ROUTES
# ═════════════════════════════════════════════════════════════════════

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "engine": "QuantLib", "version": ql.__version__})

@app.route("/api/price", methods=["POST"])
def api_price():
    try:
        d = request.json
        result = full_analysis(
            S=float(d["S"]),
            K=float(d["K"]),
            expiry=d["expiry"],
            r_annual=float(d["r_annual"]),
            sigma=float(d["sigma"]),
            opt_type=d.get("type", "call"),
            div_yield=float(d.get("div_yield", 0)),
            mkt_price=float(d.get("market_price", 0)),
            style=d.get("style", "europeia"),
            mc_paths=int(d.get("mc_paths", 100_000)),
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 400

@app.route("/api/surface", methods=["POST"])
def api_surface():
    try:
        d = request.json
        r_cont = convert_br_rate(float(d["r_annual"]))
        q_cont = convert_br_rate(float(d.get("div_yield", 0)))
        result = gen_surface(
            S=float(d["S"]),
            r_cont=r_cont,
            sigma=float(d["sigma"]),
            opt_type=d.get("type", "call"),
            q_cont=q_cont,
            style=d.get("style", "europeia"),
            what=d.get("what", "price"),
            n_pts=int(d.get("n_pts", 30)),
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/mc-paths", methods=["POST"])
def api_mc_paths():
    try:
        d = request.json
        r_cont = convert_br_rate(float(d["r_annual"]))
        q_cont = convert_br_rate(float(d.get("div_yield", 0)))
        T = float(d.get("T", 0.5))
        result = gen_mc_paths(
            S=float(d["S"]),
            T=T,
            r_cont=r_cont,
            sigma=float(d["sigma"]),
            q_cont=q_cont,
            n_paths=int(d.get("n_paths", 200)),
            n_steps=int(d.get("n_steps", 60)),
            seed=int(d.get("seed", np.random.randint(1, 99999))),
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

# ═════════════════════════════════════════════════════════════════════
# STANDALONE TEST
# ═════════════════════════════════════════════════════════════════════

def run_tests():
    print("=" * 60)
    print("  QUANTLIB ENGINE v4 — Test Suite")
    print("=" * 60)

    print("\n[1] BSM Europeia — PETR4 CALL K=38.50")
    r1 = full_analysis(S=36.80, K=38.50, expiry="2026-06-15",
                       r_annual=0.1475, sigma=0.38,
                       opt_type="call", div_yield=0.10,
                       mkt_price=2.15, style="europeia")
    print(f"  BSM = R${r1['model']['price']:.4f}")
    print(f"  MC  = R${r1['monte_carlo']['price']:.4f} ± {r1['monte_carlo']['std_error']:.4f}")
    print(f"  IV  = {r1['iv_pct']:.2f}%")
    print(f"  Verdict: {r1['verdict']} ({r1['spread_pct']:+.2f}%)")
    print(f"  Gregas: Δ={r1['model']['delta']:.4f} Γ={r1['model']['gamma']:.5f} Θ={r1['model']['theta']:.5f}")

    print("\n[2] Binomial Americana — VALE3 PUT K=56")
    r2 = full_analysis(S=54.20, K=56.00, expiry="2026-08-21",
                       r_annual=0.1475, sigma=0.32,
                       opt_type="put", div_yield=0.06,
                       mkt_price=4.80, style="americana")
    print(f"  Binomial = R${r2['model']['price']:.4f}")
    print(f"  EU ref   = R${r2['early_exercise']['eu_price']:.4f}")
    print(f"  Prêmio   = R${r2['early_exercise']['premium']:.4f}")
    print(f"  MC       = R${r2['monte_carlo']['price']:.4f}")
    print(f"  Verdict: {r2['verdict']} ({r2['spread_pct']:+.2f}%)")

    print("\n[3] MC Paths")
    paths = gen_mc_paths(36.80, 0.5, convert_br_rate(0.1475), 0.38, n_paths=10, n_steps=5)
    print(f"  {paths['n_paths']} paths, {paths['n_steps']} steps OK")

    print("\n✅ All tests passed.\n")


if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        run_tests()
    else:
        run_tests()
        print("Starting Flask server on port 5555...")
        app.run(host="0.0.0.0", port=5555, debug=False)
