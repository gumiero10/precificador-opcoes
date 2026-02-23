import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";

/* ═══════════════════════════════════════════════════════════════════════
   PRICING ENGINE v3.5 — VINICIN GOAT (Pure JS Speed + Pro UI)
   ═══════════════════════════════════════════════════════════════════════ */

// ─── Normal Distribution ───
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1, ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + s * y);
}
function normalPDF(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) }

// ─── BSM Core ───
function d1d2(S, K, T, r, sig, q = 0) {
  if (T <= 1e-10 || sig <= 1e-10) return [0, 0];
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T));
  return [d1, d1 - sig * Math.sqrt(T)];
}

function bsmPrice(S, K, T, r, sig, type = "call", q = 0) {
  if (S <= 0 || K <= 0) return 0;
  if (T <= 1e-10) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (sig <= 1e-10) { const f = S * Math.exp((r - q) * T), d = Math.exp(-r * T); return type === "call" ? Math.max(f - K, 0) * d : Math.max(K - f, 0) * d; }
  const [d1, d2] = d1d2(S, K, T, r, sig, q);
  return type === "call"
    ? S * Math.exp(-q * T) * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2)
    : K * Math.exp(-r * T) * normalCDF(-d2) - S * Math.exp(-q * T) * normalCDF(-d1);
}

function bsmGreeks(S, K, T, r, sig, type = "call", q = 0) {
  const z = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  if (S <= 0 || K <= 0 || T <= 1e-10 || sig <= 1e-10) return z;
  const [d1, d2] = d1d2(S, K, T, r, sig, q);
  const sqT = Math.sqrt(T), eqT = Math.exp(-q * T), erT = Math.exp(-r * T), nd1 = normalPDF(d1);
  const gamma = (nd1 * eqT) / (S * sig * sqT);
  const vega = S * eqT * nd1 * sqT * 0.01;
  let delta, theta, rho;
  if (type === "call") {
    delta = eqT * normalCDF(d1);
    theta = (-(S * sig * eqT * nd1) / (2 * sqT) - r * K * erT * normalCDF(d2) + q * S * eqT * normalCDF(d1)) / 252;
    rho = K * T * erT * normalCDF(d2) * 0.01;
  } else {
    delta = eqT * (normalCDF(d1) - 1);
    theta = (-(S * sig * eqT * nd1) / (2 * sqT) + r * K * erT * normalCDF(-d2) - q * S * eqT * normalCDF(-d1)) / 252;
    rho = -K * T * erT * normalCDF(-d2) * 0.01;
  }
  return { delta, gamma, theta, vega, rho };
}

// ─── CRR Binomial Tree ───
function crrPrice(S, K, T, r, sig, type = "call", q = 0, american = true, steps = 400) {
  if (S <= 0 || K <= 0) return 0;
  if (T <= 1e-10) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (sig <= 1e-10) sig = 0.0001;
  const dt = T / steps, u = Math.exp(sig * Math.sqrt(dt)), d = 1 / u;
  const disc = Math.exp(-r * dt), pUp = (Math.exp((r - q) * dt) - d) / (u - d);
  const p1 = disc * pUp, p2 = disc * (1 - pUp);
  const V = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const sT = S * Math.pow(u, steps - i) * Math.pow(d, i);
    V[i] = type === "call" ? Math.max(sT - K, 0) : Math.max(K - sT, 0);
  }
  for (let j = steps - 1; j >= 0; j--) {
    for (let i = 0; i <= j; i++) {
      const cont = p1 * V[i] + p2 * V[i + 1];
      if (american) {
        const sN = S * Math.pow(u, j - i) * Math.pow(d, i);
        V[i] = Math.max(cont, type === "call" ? Math.max(sN - K, 0) : Math.max(K - sN, 0));
      } else V[i] = cont;
    }
  }
  return V[0];
}

// ─── Finite Difference Greeks ───
function fdGreeks(S, K, T, r, sig, type = "call", q = 0, steps = 300) {
  const z = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  if (S <= 0 || K <= 0 || T <= 1e-10 || sig <= 1e-10) return z;
  const hS = S * 0.005, hSig = 0.0001, hR = 0.0001, hT = 1 / 252;
  const P0 = crrPrice(S, K, T, r, sig, type, q, true, steps);
  const Pu = crrPrice(S + hS, K, T, r, sig, type, q, true, steps);
  const Pd = crrPrice(S - hS, K, T, r, sig, type, q, true, steps);
  const delta = (Pu - Pd) / (2 * hS);
  const gamma = (Pu - 2 * P0 + Pd) / (hS * hS);
  const Pt = T > hT ? crrPrice(S, K, T - hT, r, sig, type, q, true, steps) : P0;
  const theta = Pt - P0;
  const vega = (crrPrice(S, K, T, r, sig + hSig, type, q, true, steps) - crrPrice(S, K, T, r, sig - hSig, type, q, true, steps)) / (2 * hSig) * 0.01;
  const rho = (crrPrice(S, K, T, r + hR, sig, type, q, true, steps) - crrPrice(S, K, T, r - hR, sig, type, q, true, steps)) / (2 * hR) * 0.01;
  return { delta, gamma, theta, vega, rho };
}

// ─── Monte Carlo ───
function monteCarlo(S, K, T, r, sig, type = "call", q = 0, nSims = 60000) {
  if (T <= 1e-10) return { price: type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0), se: 0, paths: [] };
  const drift = (r - q - 0.5 * sig * sig) * T, diff = sig * Math.sqrt(T);
  const half = Math.floor(nSims / 2);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < half; i++) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const s1 = S * Math.exp(drift + diff * z), s2 = S * Math.exp(drift + diff * (-z));
    const p1 = type === "call" ? Math.max(s1 - K, 0) : Math.max(K - s1, 0);
    const p2 = type === "call" ? Math.max(s2 - K, 0) : Math.max(K - s2, 0);
    const d1 = Math.exp(-r * T) * p1, d2 = Math.exp(-r * T) * p2;
    sum += d1 + d2; sumSq += d1 * d1 + d2 * d2;
  }
  const n = half * 2, mean = sum / n;
  return { price: mean, se: Math.sqrt(Math.max(sumSq / n - mean * mean, 0) / n) };
}

function mcPaths(S, T, r, sig, q = 0, nPaths = 200, nSteps = 60) {
  const dt = T / nSteps, paths = [];
  const drift = (r - q - 0.5 * sig * sig) * dt, diff = sig * Math.sqrt(dt);
  for (let p = 0; p < nPaths; p++) {
    const path = [S]; let s = S;
    for (let t = 0; t < nSteps; t++) {
      const u1 = Math.random(), u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      s = s * Math.exp(drift + diff * z); path.push(s);
    }
    paths.push(path);
  }
  return paths;
}

// ─── IV ───
function impliedVol(mkt, S, K, T, r, type = "call", q = 0, american = false) {
  if (mkt <= 0 || T <= 1e-10 || S <= 0 || K <= 0) return 0;
  const fn = american ? (s) => crrPrice(S, K, T, r, s, type, q, true, 150) : (s) => bsmPrice(S, K, T, r, s, type, q);
  let lo = 0.001, hi = 8;
  for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2; if (fn(m) > mkt) hi = m; else lo = m; if (hi - lo < 1e-9) break; }
  return (lo + hi) / 2;
}

function convertBrRate(a) { return Math.log(1 + a) }

// ─── Unified Pricer ───
function computeAll(S, K, T, r, sig, type, q, style, mkt) {
  const isAm = style === "americana";
  let p1, l1, p2, l2, mcSe = 0;
  if (isAm) {
    p1 = crrPrice(S, K, T, r, sig, type, q, true, 400); l1 = "BINOMIAL";
    p2 = crrPrice(S, K, T, r, sig, type, q, false, 400); l2 = "EUR(REF)";
  } else {
    p1 = bsmPrice(S, K, T, r, sig, type, q); l1 = "BSM";
    const mc = monteCarlo(S, K, T, r, sig, type, q, 60000); p2 = mc.price; l2 = "M.CARLO"; mcSe = mc.se;
  }
  const eep = isAm ? Math.max(p1 - p2, 0) : 0;
  const iv = impliedVol(mkt, S, K, T, r, type, q, isAm);
  const gSig = iv > 0.001 ? iv : sig;
  const greeks = isAm ? fdGreeks(S, K, T, r, gSig, type, q, 300) : bsmGreeks(S, K, T, r, gSig, type, q);
  const sp1 = p1 > 1e-4 ? ((mkt - p1) / p1) * 100 : 0;
  const sp2 = p2 > 1e-4 ? ((mkt - p2) / p2) * 100 : 0;
  const vd = s => s > 5 ? "CARA" : s < -5 ? "BARATA" : "JUSTA";
  return { price1: p1, label1: l1, price2: p2, label2: l2, mcSe, earlyExPremium: eep, iv, greeks, spread1: sp1, spread2: sp2, verdict1: vd(sp1), verdict2: vd(sp2) };
}

/* ═══════════════════════════════════════════════════════════════════════
   SCREENER DATA
   ═══════════════════════════════════════════════════════════════════════ */
const TICKERS = ["ABEV3", "AZUL4", "B3SA3", "BBAS3", "BBDC4", "BBSE3", "BOVA11", "BRAP4", "BRFS3", "CMIG4", "COGN3", "CSNA3", "CYRE3", "EGIE3", "ELET3", "EMBR3", "EQTL3", "GGBR4", "HAPV3", "HYPE3", "IRBR3", "ITSA4", "ITUB4", "JBSS3", "KLBN11", "LREN3", "MGLU3", "MULT3", "PETR3", "PETR4", "PRIO3", "RADL3", "RAIL3", "RDOR3", "RENT3", "SBSP3", "SUZB3", "TAEE11", "TIMS3", "UGPA3", "USIM5", "VALE3", "VIVT3", "WEGE3"].sort();
const EXPIRIES = ["2026-03-20", "2026-04-17", "2026-05-15", "2026-06-19", "2026-07-17", "2026-08-21", "2026-09-18", "2026-10-16", "2026-11-20", "2026-12-18"];
const R0 = convertBrRate(0.1475);
const VOL0 = 0.35;

function initSpots() {
  const s = {}; TICKERS.forEach(t => s[t] = Math.round((Math.random() * 50 + 8) * 100) / 100);
  s.PETR4 = 36.80; s.VALE3 = 62.50; s.ITUB4 = 33.20; s.BBDC4 = 13.80; s.BOVA11 = 125.00; s.WEGE3 = 52.40;
  return s;
}

function genChain(und, spot) {
  const opts = [], pfx = und.substring(0, 4);
  const strikes = [spot * 0.92, spot * 0.96, spot, spot * 1.04, spot * 1.08].map(v => Math.round(v * 2) / 2);
  EXPIRIES.forEach(exp => {
    const T = Math.max((new Date(exp) - new Date()) / (1000 * 86400 * 365), 1 / 365);
    strikes.forEach(K => {
      ["call", "put"].forEach(tp => {
        const fair = bsmPrice(spot, K, T, R0, VOL0, tp);
        const sprd = (Math.random() * 0.04) + 0.01;
        const bid = Math.max(0.01, fair * (1 - sprd)), ask = Math.max(0.02, fair * (1 + sprd));
        const mc = new Date(exp).getMonth();
        const letter = tp === "call" ? String.fromCharCode(65 + mc) : String.fromCharCode(77 + mc);
        opts.push({
          ticker: `${pfx}${letter}${Math.round(K * 10)}`, type: tp, strike: K, expiry: exp, underlying: und, spot,
          bid, ask, last: (bid + ask) / 2, prevLast: (bid + ask) / 2, fairValue: fair,
          delta: bsmGreeks(spot, K, T, R0, VOL0, tp).delta,
          time: new Date().toLocaleTimeString("pt-BR"), vol: VOL0 * 100
        });
      });
    });
  });
  return opts;
}

/* ═══════════════════════════════════════════════════════════════════════
   3D SURFACE LOCAL
   ═══════════════════════════════════════════════════════════════════════ */
function genSurf(S, r, sig, type, q, what, style) {
  const N = 38, isAm = style === "americana", ts = 80;
  const ks = [], ts2 = [];
  for (let i = 0; i < N; i++) { ks.push(S * (0.72 + 0.56 * i / (N - 1))); ts2.push(0.01 + 1.49 * i / (N - 1)); }
  const z = [];
  for (let ti = 0; ti < N; ti++) {
    const row = [];
    for (let ki = 0; ki < N; ki++) {
      if (what === "price") row.push(isAm ? crrPrice(S, ks[ki], ts2[ti], r, sig, type, q, true, ts) : bsmPrice(S, ks[ki], ts2[ti], r, sig, type, q));
      else if (what === "earlyPremium") row.push(crrPrice(S, ks[ki], ts2[ti], r, sig, type, q, true, ts) - crrPrice(S, ks[ki], ts2[ti], r, sig, type, q, false, ts));
      else { const g = isAm ? fdGreeks(S, ks[ki], ts2[ti], r, sig, type, q, 60) : bsmGreeks(S, ks[ki], ts2[ti], r, sig, type, q); row.push(g[what] || 0); }
    }
    z.push(row);
  }
  return { strikes: ks, times: ts2, z };
}

function Surf3D({ S, r, sigma, type, q, what, strike, T: uT, style }) {
  const ref = useRef(null), init = useRef(false);
  useEffect(() => {
    if (!ref.current) return;
    const { strikes, times, z } = genSurf(S, r, sigma, type, q, what, style);
    const lab = { price: "Preço(R$)", delta: "Delta", gamma: "Gamma", theta: "Theta/du", vega: "Vega/1%", rho: "Rho/1%", earlyPremium: "Prêm.Ex." };
    const cs = {
      price: [[0, "#0c0c0c"], [0.2, "#1a1a2e"], [0.5, "#0f3460"], [0.8, "#e94560"], [1, "#f5c518"]],
      delta: [[0, "#0c0c0c"], [0.5, "#533483"], [1, "#f5c518"]], gamma: [[0, "#0c0c0c"], [0.5, "#00b4d8"], [1, "#f5c518"]],
      theta: [[0, "#f5c518"], [0.5, "#e94560"], [1, "#0c0c0c"]], vega: [[0, "#0c0c0c"], [0.5, "#00b4d8"], [1, "#90e0ef"]],
      rho: [[0, "#0c0c0c"], [0.5, "#533483"], [1, "#e94560"]], earlyPremium: [[0, "#0c0c0c"], [0.5, "#2ec4b6"], [1, "#f5c518"]]
    };
    const mk = [];
    if (strike > 0 && uT > 0) {
      let zv = what === "price" ? (style === "americana" ? crrPrice(S, strike, uT, r, sigma, type, q, true, 200) : bsmPrice(S, strike, uT, r, sigma, type, q)) :
        (style === "americana" ? fdGreeks(S, strike, uT, r, sigma, type, q, 200) : bsmGreeks(S, strike, uT, r, sigma, type, q))[what] || 0;
      if (what === "earlyPremium") zv = crrPrice(S, strike, uT, r, sigma, type, q, true, 200) - crrPrice(S, strike, uT, r, sigma, type, q, false, 200);
      mk.push({
        type: "scatter3d", mode: "markers", x: [strike], y: [Math.min(Math.max(uT, 0.01), 1.5)], z: [zv],
        marker: { size: 6, color: "#f5c518", symbol: "diamond", line: { color: "#fff", width: 1 } }, showlegend: false,
        hovertemplate: `<b>SUA OPÇÃO</b><br>K:R$${strike.toFixed(2)}<br>T:${uT.toFixed(3)}a<br>${lab[what]}:${(typeof zv === 'number' ? zv : 0).toFixed(4)}<extra></extra>`
      });
    }
    const ax = { gridcolor: "rgba(245,197,24,0.06)", color: "#666", backgroundcolor: "rgba(0,0,0,0)", showbackground: false };
    const data = [{
      type: "surface", x: strikes, y: times, z, colorscale: cs[what] || cs.price, showscale: false,
      contours: { z: { show: true, usecolormap: true, highlightcolor: "rgba(245,197,24,0.2)" } },
      lighting: { ambient: 0.75, diffuse: 0.55, specular: 0.12, roughness: 0.7 }, opacity: 0.92,
      hovertemplate: `K:R$%{x:.2f}<br>T:%{y:.3f}a<br>${lab[what]}:%{z:.4f}<extra></extra>`
    }, ...mk];
    const layout = {
      scene: {
        xaxis: { ...ax, title: { text: "Strike", font: { size: 10, family: "DM Mono" } } },
        yaxis: { ...ax, title: { text: "Tempo(a)", font: { size: 10, family: "DM Mono" } } },
        zaxis: { ...ax, title: { text: lab[what], font: { size: 10, family: "DM Mono" } } },
        bgcolor: "rgba(0,0,0,0)", camera: { eye: { x: 1.5, y: -1.6, z: 0.85 } }
      },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", margin: { l: 0, r: 0, t: 0, b: 0 },
      hoverlabel: { bgcolor: "#111", bordercolor: "#f5c518", font: { color: "#eee", family: "DM Mono", size: 11 } }
    };
    if (init.current) Plotly.react(ref.current, data, layout, { responsive: true, displayModeBar: false, scrollZoom: true });
    else { Plotly.newPlot(ref.current, data, layout, { responsive: true, displayModeBar: false, scrollZoom: true }); init.current = true; }
    return () => { if (ref.current) try { Plotly.purge(ref.current) } catch (e) { } init.current = false; };
  }, [S, r, sigma, type, q, what, strike, uT, style]);
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}

/* ═══════════════════════════════════════════════════════════════════════
   MONTE CARLO VISUALIZATION LOCAL
   ═══════════════════════════════════════════════════════════════════════ */
function MCViz({ S, K, T, r, sigma, type, q }) {
  const ref = useRef(null), init = useRef(false);
  useEffect(() => {
    if (!ref.current || T <= 0.001) return;
    const nPaths = 150, nSteps = 50;
    const paths = mcPaths(S, T, r, sigma, q, nPaths, nSteps);
    const timeAxis = []; for (let i = 0; i <= nSteps; i++) timeAxis.push((T * i / nSteps).toFixed(3));
    const traces = paths.map((p, idx) => {
      const finalS = p[p.length - 1];
      const payoff = type === "call" ? Math.max(finalS - K, 0) : Math.max(K - finalS, 0);
      const itm = payoff > 0;
      return {
        x: timeAxis, y: p, type: "scatter", mode: "lines",
        line: { color: itm ? "rgba(46,196,178,0.25)" : "rgba(233,69,96,0.12)", width: 0.8 },
        showlegend: false, hoverinfo: "skip"
      };
    });
    traces.push({
      x: [timeAxis[0], timeAxis[timeAxis.length - 1]], y: [K, K], type: "scatter", mode: "lines",
      line: { color: "#f5c518", width: 2, dash: "dash" }, name: `Strike R$${K.toFixed(2)}`, showlegend: true
    });
    traces.push({
      x: [timeAxis[0], timeAxis[timeAxis.length - 1]], y: [S, S], type: "scatter", mode: "lines",
      line: { color: "#0A84FF", width: 1.5, dash: "dot" }, name: `Spot R$${S.toFixed(2)}`, showlegend: true
    });
    const finals = paths.map(p => p[p.length - 1]);
    const payoffs = finals.map(f => Math.exp(-r * T) * (type === "call" ? Math.max(f - K, 0) : Math.max(K - f, 0)));
    const avgPrice = payoffs.reduce((a, b) => a + b, 0) / payoffs.length;
    const itmCount = payoffs.filter(p => p > 0).length;

    const layout = {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "DM Mono", color: "#888", size: 10 },
      xaxis: { title: "Tempo (anos)", gridcolor: "#1a1a1a", color: "#666", zerolinecolor: "#1a1a1a" },
      yaxis: { title: "Preço do Ativo (R$)", gridcolor: "#1a1a1a", color: "#666", zerolinecolor: "#1a1a1a" },
      margin: { l: 50, r: 20, t: 30, b: 40 },
      legend: { bgcolor: "rgba(0,0,0,0)", font: { color: "#888", size: 10 }, x: 0.02, y: 0.98 },
      annotations: [{
        x: 0.98, y: 0.02, xref: "paper", yref: "paper", text:
          `<b>${nPaths} paths | ${itmCount} ITM (${(itmCount / nPaths * 100).toFixed(0)}%)</b><br>Preço MC: R$${avgPrice.toFixed(4)}`,
        showarrow: false, font: { color: "#f5c518", size: 11, family: "DM Mono" }, align: "right", bgcolor: "rgba(0,0,0,0.6)", borderpad: 6
      }],
      hoverlabel: { bgcolor: "#111", bordercolor: "#f5c518", font: { color: "#eee", family: "DM Mono" } }
    };
    if (init.current) Plotly.react(ref.current, traces, layout, { responsive: true, displayModeBar: false });
    else { Plotly.newPlot(ref.current, traces, layout, { responsive: true, displayModeBar: false }); init.current = true; }
    return () => { if (ref.current) try { Plotly.purge(ref.current) } catch (e) { } init.current = false; };
  }, [S, K, T, r, sigma, type, q]);
  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}

/* ═══════════════════════════════════════════════════════════════════════
   MATH REASONING PANEL LOCAL
   ═══════════════════════════════════════════════════════════════════════ */
function MathPanel({ S, K, T, r, sig, type, q, style, mkt, result }) {
  if (!result) return null;
  const isAm = style === "americana";
  const [d1, d2] = d1d2(S, K, T, r, sig, q);
  const iv = result.iv;
  const fmt = v => typeof v === "number" ? v.toFixed(6) : v;
  return (
    <div className="no-scroll" style={{
      background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 8, padding: 16, fontSize: 11,
      fontFamily: "'DM Mono',monospace", color: "#888", lineHeight: 2, overflowX: "auto"
    }}>
      <div style={{ color: "#f5c518", fontSize: 12, marginBottom: 8, fontWeight: 600 }}>
        RACIOCÍNIO MATEMÁTICO — {isAm ? "BINOMIAL CRR" : "BLACK-SCHOLES-MERTON"}
      </div>
      <div style={{ color: "#555", marginBottom: 12 }}>═══════════════════════════════════════</div>

      <div style={{ color: "#aaa" }}>1. INPUTS UTILIZADOS</div>
      <div style={{ paddingLeft: 12, color: "#666" }}>
        S (Spot) = R${S.toFixed(2)}<br />
        K (Strike) = R${K.toFixed(2)}<br />
        T (Tempo) = {T.toFixed(6)} anos ({Math.round(T * 365)} dias / ~{Math.round(T * 252)} DU)<br />
        r (Risk-Free contínua) = {(r * 100).toFixed(4)}% [input: {((Math.exp(r) - 1) * 100).toFixed(2)}% a.a. → ln(1+r)]<br />
        σ (Volatilidade) = {(sig * 100).toFixed(2)}%<br />
        q (Div Yield contínua) = {(q * 100).toFixed(4)}%<br />
        Tipo: {type.toUpperCase()} · Estilo: {isAm ? "AMERICANA" : "EUROPEIA"}
      </div>

      {!isAm && (
        <>
          <div style={{ color: "#555", margin: "12px 0" }}>───────────────────────────</div>
          <div style={{ color: "#aaa" }}>2. CÁLCULO d₁ e d₂</div>
          <div style={{ paddingLeft: 12, color: "#666" }}>
            d₁ = [ln(S/K) + (r - q + σ²/2)·T] / (σ·√T)<br />
            d₁ = [ln({S.toFixed(2)}/{K.toFixed(2)}) + ({(r).toFixed(6)} - {(q).toFixed(6)} + {(sig * sig / 2).toFixed(6)})·{T.toFixed(6)}] / ({sig.toFixed(4)}·{Math.sqrt(T).toFixed(6)})<br />
            d₁ = {fmt(d1)}<br /><br />
            d₂ = d₁ - σ·√T = {fmt(d1)} - {(sig * Math.sqrt(T)).toFixed(6)}<br />
            d₂ = {fmt(d2)}
          </div>

          <div style={{ color: "#555", margin: "12px 0" }}>───────────────────────────</div>
          <div style={{ color: "#aaa" }}>3. N(d₁) e N(d₂) — CDF Normal Padrão</div>
          <div style={{ paddingLeft: 12, color: "#666" }}>
            N(d₁) = N({fmt(d1)}) = {normalCDF(d1).toFixed(8)}<br />
            N(d₂) = N({fmt(d2)}) = {normalCDF(d2).toFixed(8)}<br />
            {type === "put" && <>N(-d₁) = {normalCDF(-d1).toFixed(8)}<br />N(-d₂) = {normalCDF(-d2).toFixed(8)}<br /></>}
          </div>

          <div style={{ color: "#555", margin: "12px 0" }}>───────────────────────────</div>
          <div style={{ color: "#aaa" }}>4. PREÇO BSM ({type.toUpperCase()})</div>
          <div style={{ paddingLeft: 12, color: "#666" }}>
            {type === "call" ? <>
              C = S·e^(-qT)·N(d₁) - K·e^(-rT)·N(d₂)<br />
              C = {S.toFixed(2)}·{Math.exp(-q * T).toFixed(6)}·{normalCDF(d1).toFixed(6)} - {K.toFixed(2)}·{Math.exp(-r * T).toFixed(6)}·{normalCDF(d2).toFixed(6)}<br />
              C = {(S * Math.exp(-q * T) * normalCDF(d1)).toFixed(6)} - {(K * Math.exp(-r * T) * normalCDF(d2)).toFixed(6)}<br />
            </> : <>
              P = K·e^(-rT)·N(-d₂) - S·e^(-qT)·N(-d₁)<br />
              P = {K.toFixed(2)}·{Math.exp(-r * T).toFixed(6)}·{normalCDF(-d2).toFixed(6)} - {S.toFixed(2)}·{Math.exp(-q * T).toFixed(6)}·{normalCDF(-d1).toFixed(6)}<br />
            </>}
            <span style={{ color: "#f5c518", fontSize: 13, fontWeight: 700 }}>Fair Value BSM = R${result.price1.toFixed(4)}</span>
          </div>
        </>
      )}

      {isAm && (
        <>
          <div style={{ color: "#555", margin: "12px 0" }}>───────────────────────────</div>
          <div style={{ color: "#aaa" }}>2. ÁRVORE BINOMIAL CRR (400 steps)</div>
          <div style={{ paddingLeft: 12, color: "#666" }}>
            dt = T/N = {T.toFixed(6)}/{400} = {(T / 400).toFixed(8)}<br />
            u = e^(σ·√dt) = e^({sig.toFixed(4)}·{Math.sqrt(T / 400).toFixed(6)}) = {Math.exp(sig * Math.sqrt(T / 400)).toFixed(8)}<br />
            d = 1/u = {(1 / Math.exp(sig * Math.sqrt(T / 400))).toFixed(8)}<br />
            p = [e^((r-q)·dt) - d] / (u - d) = {((Math.exp((r - q) * (T / 400)) - 1 / Math.exp(sig * Math.sqrt(T / 400))) / (Math.exp(sig * Math.sqrt(T / 400)) - 1 / Math.exp(sig * Math.sqrt(T / 400)))).toFixed(8)}<br /><br />
            Backward induction: em cada nó, V = max(exercício, continuação)<br />
            Exercício = max(S_node - K, 0) para Call / max(K - S_node, 0) para Put<br />
            Continuação = e^(-r·dt) · [p·V_up + (1-p)·V_down]<br /><br />
            <span style={{ color: "#f5c518", fontSize: 13, fontWeight: 700 }}>Fair Value Binomial = R${result.price1.toFixed(4)}</span><br />
            Preço europeu equiv. = R${result.price2.toFixed(4)}<br />
            Prêmio exercício antecipado = R${result.earlyExPremium.toFixed(4)}
          </div>
        </>
      )}

      <div style={{ color: "#555", margin: "12px 0" }}>───────────────────────────</div>
      <div style={{ color: "#aaa" }}>{isAm ? "3" : "5"}. VOLATILIDADE IMPLÍCITA (via Bisection)</div>
      <div style={{ paddingLeft: 12, color: "#666" }}>
        Busca σ_iv tal que Modelo(σ_iv) = Preço_Mercado = R${mkt.toFixed(4)}<br />
        Intervalo: [0.1%, 800%] · 300 iterações · tol = 1e-9<br />
        <span style={{ color: iv > sig ? "#e94560" : "#2ec4b6", fontWeight: 600 }}>σ_iv = {(iv * 100).toFixed(4)}%</span>
        {iv > sig ? " (mercado precifica MAIS risco que histórico)" : " (mercado precifica MENOS risco)"}
      </div>

      <div style={{ color: "#555", margin: "12px 0" }}>───────────────────────────</div>
      <div style={{ color: "#aaa" }}>{isAm ? "4" : "6"}. VEREDITO</div>
      <div style={{ paddingLeft: 12, color: "#666" }}>
        Spread = (Mercado - FairValue) / FairValue × 100<br />
        Spread = (R${mkt.toFixed(4)} - R${result.price1.toFixed(4)}) / R${result.price1.toFixed(4)} × 100<br />
        <span style={{ color: result.verdict1 === "CARA" ? "#e94560" : result.verdict1 === "BARATA" ? "#2ec4b6" : "#888", fontSize: 13, fontWeight: 700 }}>
          Spread = {result.spread1 > 0 ? "+" : ""}{result.spread1.toFixed(2)}% → {result.verdict1}
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   MICRO COMPONENTS
   ═══════════════════════════════════════════════════════════════════════ */
const Pill = ({ children, active, onClick }) => <button onClick={onClick} style={{
  padding: "5px 11px", fontSize: 11, fontFamily: "'DM Mono',monospace", borderRadius: 4, border: "none", cursor: "pointer",
  fontWeight: 500, background: active ? "rgba(245,197,24,0.12)" : "transparent", color: active ? "#f5c518" : "#555"
}}>{children}</button>;

const Met = ({ label, value, unit, color, small }) => <div style={{ padding: small ? "8px 10px" : "12px 14px", background: "#111", borderRadius: 8, borderLeft: `2px solid ${color || "#222"}` }}>
  <div style={{ fontSize: 10, color: "#555", letterSpacing: 1.2, marginBottom: 4, fontFamily: "'DM Mono',monospace" }}>{label}</div>
  <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
    <span style={{ fontSize: small ? 14 : 18, fontWeight: 600, color: color || "#ddd", fontFamily: "'DM Mono',monospace" }}>{value}</span>
    {unit && <span style={{ fontSize: 10, color: "#555" }}>{unit}</span>}
  </div>
</div>;

const Sep = () => <div style={{ height: 1, background: "linear-gradient(90deg,transparent,#222,transparent)", margin: "12px 0" }} />;
const fmtR = v => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ═══════════════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════════════ */
export default function App() {
  const [tab, setTab] = useState("screener");
  // screener
  const [asset, setAsset] = useState("PETR4");
  const [expF, setExpF] = useState("ALL");
  const [typeF, setTypeF] = useState("ALL");
  const [chain, setChain] = useState([]);
  const [tick, setTick] = useState(new Date());
  const spots = useRef(initSpots());
  // analysis
  const [ticker, setTicker] = useState("PETR4");
  const [spot, setSpot] = useState(36.80);
  const [strike, setStrike] = useState(38.50);
  const [expiry, setExpiry] = useState("2026-06-15");
  const [rateA, setRateA] = useState(14.75);
  const [vol, setVol] = useState(38);
  const [optT, setOptT] = useState("call");
  const [mkt, setMkt] = useState(2.15);
  const [divY, setDivY] = useState(10);
  const [surf, setSurf] = useState("price");
  const [style, setStyle] = useState("europeia");
  const [comp, setComp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showMath, setShowMath] = useState(false);
  const [vizTab, setVizTab] = useState("surface");
  const [enable3D, setEnable3D] = useState(false);

  // Resize State
  const [leftW, setLeftW] = useState(310);
  const [rightW, setRightW] = useState(320);
  const [resizing, setResizing] = useState(null);

  const T = useMemo(() => Math.max((new Date(expiry).getTime() - Date.now()) / (1000 * 86400 * 365), 1 / 365), [expiry]);
  const days = useMemo(() => Math.max(Math.round((new Date(expiry) - new Date()) / 86400000), 0), [expiry]);
  const r = useMemo(() => convertBrRate(rateA / 100), [rateA]);
  const q = useMemo(() => convertBrRate(divY / 100), [divY]);
  const sig = vol / 100;
  const isAm = style === "americana";

  // RESIZER MOUSE EVENTS
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (resizing === 'left') {
        setLeftW(Math.max(260, Math.min(e.clientX - 24, 600)));
      } else if (resizing === 'right') {
        setRightW(Math.max(280, Math.min(window.innerWidth - e.clientX - 24, 700)));
      }
    };
    const handleMouseUp = () => setResizing(null);

    if (resizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing]);

  // LOCAL COMPUTATION (Ultra Fast JS V8 Engine)
  const compute = useCallback(() => {
    setBusy(true);
    requestAnimationFrame(() => {
      setComp(computeAll(spot, strike, T, r, sig, optT, q, style, mkt));
      setBusy(false);
    });
  }, [spot, strike, T, r, sig, optT, q, mkt, style]);

  useEffect(() => { compute(); }, [compute]);

  // Load chain (Screener)
  useEffect(() => { if (asset && asset !== "ALL") setChain(genChain(asset, spots.current[asset] || 30)); }, [asset]);

  // Live feed (Screener)
  useEffect(() => {
    const iv = setInterval(() => {
      setChain(prev => prev.map(o => {
        const ns = spots.current[o.underlying] * (1 + (Math.random() - 0.5) * 0.004);
        spots.current[o.underlying] = ns;
        const oT = Math.max((new Date(o.expiry) - new Date()) / (1000 * 86400 * 365), 1 / 365);
        const nf = bsmPrice(ns, o.strike, oT, R0, VOL0, o.type);
        const sp = (Math.random() * 0.04) + 0.01;
        const bid = Math.max(0.01, nf * (1 - sp)), ask = Math.max(0.02, nf * (1 + sp));
        const nl = (bid + ask) / 2;
        const d = bsmGreeks(ns, o.strike, oT, R0, VOL0, o.type).delta;
        return { ...o, spot: ns, prevLast: o.last, last: nl, bid, ask, fairValue: nf, delta: d, time: new Date().toLocaleTimeString("pt-BR") };
      }));
      setTick(new Date());
    }, 5000);
    return () => clearInterval(iv);
  }, [asset]);

  useEffect(() => { if (surf === "earlyPremium" && !isAm) setSurf("price"); }, [style, surf, isAm]);

  const vc = v => v === "CARA" ? "#e94560" : v === "BARATA" ? "#2ec4b6" : "#666";
  const mLabel = optT === "call" ? (spot > strike * 1.02 ? "ITM" : spot < strike * 0.98 ? "OTM" : "ATM") : (spot < strike * 0.98 ? "ITM" : spot > strike * 1.02 ? "OTM" : "ATM");

  const filteredChain = useMemo(() => chain.filter(o => (expF === "ALL" || o.expiry === expF) && (typeF === "ALL" || o.type === typeF)), [chain, expF, typeF]);

  const currentSpot = spots.current[asset] || 0;
  const surfTabs = isAm ? ["price", "earlyPremium", "delta", "gamma", "theta", "vega"] : ["price", "delta", "gamma", "theta", "vega", "rho"];
  const surfLab = { price: "Preço", delta: "Delta", gamma: "Gamma", theta: "Theta", vega: "Vega", rho: "Rho", earlyPremium: "Prêm.Ex." };

  const inDefs = [
    { id: "spot", l: "Spot(R$)", v: spot, s: v => setSpot(+v), t: "number", st: "0.01" },
    { id: "strike", l: "Strike(R$)", v: strike, s: v => setStrike(+v), t: "number", st: "0.01" },
    { id: "mkt", l: "Preço Tela(R$)", v: mkt, s: v => setMkt(+v), t: "number", st: "0.01" },
    { id: "rate", l: "Risk-Free(%a.a.)", v: rateA, s: v => setRateA(+v), t: "number", st: "0.01" },
    { id: "vol", l: "Vol(%)", v: vol, s: v => setVol(+v), t: "number", st: "0.1" },
    { id: "div", l: "DivYield(%)", v: divY, s: v => setDivY(+v), t: "number", st: "0.1" },
  ];

  return (
    <div style={ST.root}>
      <style>{`
      @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Instrument+Sans:wght@400;500;600;700&display=swap');
      *{box-sizing:border-box;margin:0;padding:0}
      ::-webkit-scrollbar{width:4px}
      ::-webkit-scrollbar-track{background:#0a0a0a}
      ::-webkit-scrollbar-thumb{background:#222;border-radius:2px}
      
      .no-scroll { -ms-overflow-style: none; scrollbar-width: none; overflow-y: scroll; }
      .no-scroll::-webkit-scrollbar { display: none; }

      .resizer { width: 16px; cursor: col-resize; display: flex; justify-content: center; align-items: center; z-index: 10; }
      .resizer-handle { width: 2px; height: 30px; background: #222; border-radius: 2px; transition: background 0.2s; }
      .resizer:hover .resizer-handle, .resizer.active .resizer-handle { background: #f5c518; }

      body{overflow:hidden;background:#0a0a0a}
      input[type=number]{-moz-appearance:textfield}
      input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none}
      .fi{display:flex;flex-direction:column;gap:4px}
      .fi label{font-size:10px;color:#555;letter-spacing:1px;font-family:'DM Mono',monospace;text-transform:uppercase}
      .fi input,.fi select{background:#0e0e0e;border:1px solid #1a1a1a;color:#ccc;padding:8px 10px;border-radius:5px;font-family:'DM Mono',monospace;font-size:12px;outline:none;transition:border-color 0.2s}
      .fi input:focus,.fi select:focus{border-color:#f5c518}
      .fi select option{background:#0e0e0e;color:#ccc}
      @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
      .tu{animation:flashG 0.8s ease-out}.td{animation:flashR 0.8s ease-out}
      @keyframes flashG{0%{background:rgba(46,196,178,0.2)}100%{background:transparent}}
      @keyframes flashR{0%{background:rgba(233,69,96,0.2)}100%{background:transparent}}
      tr:hover{background:rgba(255,255,255,0.02)}
    `}</style>

      <datalist id="tk">{TICKERS.map(t => <option key={t} value={t} />)}</datalist>

      <header style={ST.hd}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={ST.logo}><span style={{ fontSize: 11, fontWeight: 700, color: "#f5c518", lineHeight: 1, textAlign: "center" }}>vinicin<br />goat</span></div>
          <div style={{ display: "flex", gap: 3, background: "#111", padding: 3, borderRadius: 6 }}>
            {[["screener", "Screener Live"], ["single", "Análise Individual"], ["mc", "Monte Carlo"]].map(([k, l]) =>
              <button key={k} onClick={() => setTab(k)} style={tab === k ? ST.tabA : ST.tabI}>{l}</button>)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, fontFamily: "'DM Mono',monospace", background: "rgba(245,197,24,0.08)", color: "#f5c518", border: "1px solid rgba(245,197,24,0.15)" }}>ENGINE v3.5 JS</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#2ec4b6", fontFamily: "'DM Mono',monospace" }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#2ec4b6", animation: "blink 2.5s infinite" }} />
            {tab === "screener" ? "FEED ATIVO" : "READY"}
          </div>
        </div>
      </header>

      {/* ════════ SCREENER ════════ */}
      {tab === "screener" && (
        <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 72px)", background: "#0e0e0e", borderRadius: 10, border: "1px solid #1a1a1a" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #1a1a1a", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#888" }}>ATIVO:</div>
            <input type="text" list="tk" placeholder="PETR4" value={asset} onChange={e => setAsset(e.target.value.toUpperCase())}
              style={{ background: "#111", border: "1px solid #333", color: "#f5c518", padding: "7px 12px", borderRadius: 5, fontFamily: "'DM Mono',monospace", fontSize: 14, fontWeight: 700, width: 130, outline: "none" }} />
            
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#111", padding: "6px 14px", borderRadius: 6, border: "1px solid #1a1a1a" }}>
              <span style={{ fontSize: 10, color: "#555", fontFamily: "'DM Mono',monospace" }}>SPOT</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#fff", fontFamily: "'DM Mono',monospace" }}>R${fmtR(currentSpot)}</span>
            </div>

            <select value={expF} onChange={e => setExpF(e.target.value)} style={{ background: "#111", border: "1px solid #222", color: "#ccc", padding: "7px 12px", borderRadius: 5, fontFamily: "'DM Mono',monospace", fontSize: 12, outline: "none" }}>
              <option value="ALL">Todos Vencimentos</option>
              {EXPIRIES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>

            <div style={{ display: "flex", gap: 2, background: "#111", padding: 3, borderRadius: 5 }}>
              {[["ALL", "TODOS"], ["call", "CALL"], ["put", "PUT"]].map(([k, l]) =>
                <button key={k} onClick={() => setTypeF(k)} style={{
                  padding: "5px 12px", fontSize: 10, border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "'DM Mono',monospace", fontWeight: 600,
                  background: typeF === k ? (k === "call" ? "rgba(10,132,255,0.15)" : k === "put" ? "rgba(233,69,96,0.15)" : "rgba(245,197,24,0.1)") : "transparent",
                  color: typeF === k ? (k === "call" ? "#0A84FF" : k === "put" ? "#e94560" : "#f5c518") : "#555"
                }}>{l}</button>)}
            </div>

            <div style={{ flex: 1 }} />
            <div style={{ fontSize: 11, color: "#555", fontFamily: "'DM Mono',monospace" }}>Att: {tick.toLocaleTimeString()}</div>
          </div>

          <div className="no-scroll" style={{ flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "right", fontFamily: "'DM Mono',monospace", fontSize: 12 }}>
              <thead style={{ position: "sticky", top: 0, background: "#151515", zIndex: 2 }}>
                <tr style={{ color: "#666", borderBottom: "1px solid #222" }}>
                  <th style={{ ...ST.th, textAlign: "left" }}>Opção</th>
                  <th style={{ ...ST.th, textAlign: "left" }}>Ativo</th>
                  <th style={ST.th}>Spot</th>
                  <th style={ST.th}>Tipo</th>
                  <th style={ST.th}>Strike</th>
                  <th style={ST.th}>Venc.</th>
                  <th style={ST.th}>BID</th>
                  <th style={ST.th}>ASK</th>
                  <th style={ST.th}>Fair BSM</th>
                  <th style={ST.th}>Delta</th>
                  <th style={ST.th}>Veredito</th>
                </tr>
              </thead>
              <tbody>
                {filteredChain.map(o => {
                  const sprd = o.fairValue > 0.01 ? ((((o.bid + o.ask) / 2) - o.fairValue) / o.fairValue) * 100 : 0;
                  const vrd = sprd > 5 ? "CARA" : sprd < -5 ? "BARATA" : "JUSTA";
                  const tc = o.last > o.prevLast ? "tu" : o.last < o.prevLast ? "td" : "";
                  return (<tr key={o.ticker + o.expiry} className={tc} style={{ borderBottom: "1px solid #111" }}>
                    <td style={{ ...ST.td, color: "#f5c518", fontWeight: 600, textAlign: "left" }}>{o.ticker}</td>
                    <td style={{ ...ST.td, color: "#666", textAlign: "left" }}>{o.underlying}</td>
                    <td style={{ ...ST.td, color: "#fff", fontWeight: 600 }}>{fmtR(o.spot)}</td>
                    <td style={{ ...ST.td, color: o.type === "call" ? "#0A84FF" : "#e94560", fontWeight: 600 }}>{o.type.toUpperCase()}</td>
                    <td style={ST.td}>{fmtR(o.strike)}</td>
                    <td style={{ ...ST.td, color: "#555", fontSize: 10 }}>{o.expiry}</td>
                    <td style={{ ...ST.td, color: "#2ec4b6", fontWeight: 600 }}>{fmtR(o.bid)}</td>
                    <td style={{ ...ST.td, color: "#e94560", fontWeight: 600 }}>{fmtR(o.ask)}</td>
                    <td style={{ ...ST.td, color: "#00b4d8", fontWeight: 600 }}>{fmtR(o.fairValue)}</td>
                    <td style={{ ...ST.td, color: o.delta > 0 ? "#f5c518" : "#e94560" }}>{o.delta >= 0 ? "+" : ""}{o.delta.toFixed(3)}</td>
                    <td style={ST.td}><span style={{
                      padding: "4px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                      background: vrd === "CARA" ? "rgba(233,69,96,0.12)" : vrd === "BARATA" ? "rgba(46,196,178,0.12)" : "rgba(255,255,255,0.04)",
                      color: vrd === "CARA" ? "#e94560" : vrd === "BARATA" ? "#2ec4b6" : "#666"
                    }}>{vrd} ({sprd > 0 ? "+" : ""}{sprd.toFixed(1)}%)</span></td>
                  </tr>);
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════ MONTE CARLO VIZ ════════ */}
      {tab === "mc" && (
        <div style={{ display: "flex", height: "calc(100vh - 72px)" }}>
          
          <div className="no-scroll" style={{ ...ST.pn, width: leftW, flexShrink: 0 }}>
            <div style={ST.sh}><span style={{ color: "#f5c518" }}>MC</span> PARÂMETROS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {inDefs.slice(0, 4).map(d => <div className="fi" key={d.id}><label>{d.l}</label><input type={d.t} step={d.st} value={d.v} onChange={e => d.s(e.target.value)} /></div>)}
            </div>
            <div className="fi" style={{ marginTop: 8 }}><label>Tipo</label>
              <select value={optT} onChange={e => setOptT(e.target.value)}><option value="call">CALL</option><option value="put">PUT</option></select>
            </div>
            <div className="fi" style={{ marginTop: 8 }}><label>Vencimento</label><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></div>
            <Sep />
            <div style={{ fontSize: 10, color: "#555", fontFamily: "'DM Mono',monospace", lineHeight: 1.8 }}>
              <span style={{ color: "#2ec4b6" }}>Verde</span> = paths ITM no vencimento<br />
              <span style={{ color: "#e94560" }}>Vermelho</span> = paths OTM<br />
              Linha <span style={{ color: "#f5c518" }}>dourada tracejada</span> = Strike<br />
              Linha <span style={{ color: "#0A84FF" }}>azul pontilhada</span> = Spot atual<br /><br />
              <span style={{ color: "#888" }}>150 caminhos GBM simulados com antithetic variates. Cada recarga gera novos paths no navegador.</span>
            </div>
          </div>

          <div className={`resizer ${resizing === 'left' ? 'active' : ''}`} onMouseDown={() => setResizing('left')}>
            <div className="resizer-handle" />
          </div>

          <div style={{ ...ST.pn, flex: 1, minWidth: 0, padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={ST.sh}><span style={{ color: "#f5c518" }}>◇</span> SIMULAÇÃO MONTE CARLO — {optT.toUpperCase()} K={strike} T={T.toFixed(3)}a</div>
              <button onClick={() => setEnable3D(!enable3D)} style={{
                padding: "5px 12px", fontSize: 10, border: "1px solid " + (enable3D ? "#e94560" : "#2ec4b6"), borderRadius: 4, cursor: "pointer",
                fontFamily: "'DM Mono',monospace", fontWeight: 600,
                background: enable3D ? "rgba(233,69,96,0.1)" : "rgba(46,196,178,0.1)",
                color: enable3D ? "#e94560" : "#2ec4b6"
              }}>{enable3D ? "DESLIGAR" : "LIGAR GRÁFICO"}</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: "radial-gradient(ellipse at 50% 80%,#0a0a12,#080808)" }}>
              {enable3D ? <MCViz S={spot} K={strike} T={T} r={r} sigma={sig} type={optT} q={q} /> : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#333", fontFamily: "'DM Mono',monospace", fontSize: 12 }}>
                  Clique em "LIGAR GRÁFICO" para renderizar a simulação MC
                </div>
              )}
            </div>
          </div>

        </div>
      )}

      {/* ════════ SINGLE ANALYSIS ════════ */}
      {tab === "single" && (
        <div style={{ display: "flex", height: "calc(100vh - 72px)" }}>
          
          {/* LEFT INPUTS */}
          <div className="no-scroll" style={{ ...ST.pn, width: leftW, flexShrink: 0 }}>
            <div style={ST.sh}><span style={{ color: "#f5c518" }}>01</span> PARÂMETROS</div>
            <div style={{ display: "flex", background: "#0a0a0a", borderRadius: 5, padding: 3, border: "1px solid #1a1a1a", gap: 2, marginBottom: 10 }}>
              {[["europeia", "EUROPEIA", "EU"], ["americana", "AMERICANA", "US"]].map(([k, l, ic]) =>
                <button key={k} onClick={() => setStyle(k)} style={{
                  flex: 1, padding: "7px 4px", borderRadius: 4, border: "none", cursor: "pointer",
                  fontFamily: "'DM Mono',monospace", fontSize: 10, fontWeight: 600, letterSpacing: 1,
                  background: style === k ? (k === "europeia" ? "rgba(10,132,255,0.1)" : "rgba(233,69,96,0.1)") : "transparent",
                  color: style === k ? (k === "europeia" ? "#0A84FF" : "#e94560") : "#444"
                }}><span style={{ fontSize: 8, display: "block", marginBottom: 1, opacity: 0.5 }}>{ic}</span>{l}</button>)}
            </div>
            <div className="fi"><label>Ativo</label><input list="tk" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} /></div>
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {inDefs.map(d => <div className="fi" key={d.id}><label>{d.l}</label><input type={d.t} step={d.st} value={d.v} onChange={e => d.s(e.target.value)} /></div>)}
              <div className="fi"><label>Tipo</label><select value={optT} onChange={e => setOptT(e.target.value)}><option value="call">CALL</option><option value="put">PUT</option></select></div>
            </div>
            <div className="fi" style={{ marginTop: 8 }}><label>Vencimento</label><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, fontSize: 10, fontFamily: "'DM Mono',monospace", color: "#444", flexWrap: "wrap" }}>
              <span style={{ background: "#111", padding: "3px 6px", borderRadius: 3 }}>{days}d</span>
              <span style={{ background: "#111", padding: "3px 6px", borderRadius: 3 }}>T={T.toFixed(4)}</span>
              <span style={{
                background: mLabel === "ITM" ? "rgba(46,196,178,0.08)" : mLabel === "OTM" ? "rgba(233,69,96,0.08)" : "#111",
                color: mLabel === "ITM" ? "#2ec4b6" : mLabel === "OTM" ? "#e94560" : "#555", padding: "3px 6px", borderRadius: 3
              }}>{mLabel}</span>
              <span style={{
                background: isAm ? "rgba(233,69,96,0.08)" : "rgba(10,132,255,0.08)",
                color: isAm ? "#e94560" : "#0A84FF", padding: "3px 6px", borderRadius: 3
              }}>{isAm ? "AMER" : "EUR"}</span>
            </div>
            <Sep />
            <button onClick={compute} disabled={busy} style={{ ...ST.btn, opacity: busy ? 0.5 : 1 }}>{busy ? "..." : "CALCULAR"}</button>
          </div>

          {/* LEFT RESIZER */}
          <div className={`resizer ${resizing === 'left' ? 'active' : ''}`} onMouseDown={() => setResizing('left')}>
            <div className="resizer-handle" />
          </div>

          {/* CENTER VIZ */}
          <div style={{ ...ST.pn, flex: 1, minWidth: 0, padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px 6px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <div style={{ display: "flex", gap: 3, background: "#0e0e0e", padding: 3, borderRadius: 5 }}>
                <Pill active={vizTab === "surface"} onClick={() => setVizTab("surface")}>Superfície</Pill>
                <Pill active={vizTab === "montecarlo"} onClick={() => setVizTab("montecarlo")}>Monte Carlo</Pill>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {vizTab === "surface" && (
                  <div style={{ display: "flex", gap: 2, background: "#0e0e0e", padding: 3, borderRadius: 5, flexWrap: "wrap" }}>
                    {surfTabs.map(k => <Pill key={k} active={surf === k} onClick={() => setSurf(k)}>{surfLab[k]}</Pill>)}
                  </div>
                )}
                <button onClick={() => setEnable3D(!enable3D)} style={{
                  padding: "5px 12px", fontSize: 10, border: "1px solid " + (enable3D ? "#e94560" : "#2ec4b6"), borderRadius: 4, cursor: "pointer",
                  fontFamily: "'DM Mono',monospace", fontWeight: 600, letterSpacing: 1,
                  background: enable3D ? "rgba(233,69,96,0.1)" : "rgba(46,196,178,0.1)",
                  color: enable3D ? "#e94560" : "#2ec4b6"
                }}>{enable3D ? "DESLIGAR 3D" : "LIGAR 3D"}</button>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, background: "radial-gradient(ellipse at 50% 80%,#0a0a12,#080808)" }}>
              {vizTab === "surface" && enable3D && <Surf3D S={spot} r={r} sigma={sig} type={optT} q={q} what={surf} strike={strike} T={T} style={style} />}
              {vizTab === "montecarlo" && enable3D && <MCViz S={spot} K={strike} T={T} r={r} sigma={sig} type={optT} q={q} />}
              {!enable3D && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16, padding: 32 }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="1.5">
                    <path d="M12 3L1 9l11 6 11-6-11-6z" /><path d="M1 9v8l11 6 11-6V9" /><path d="M12 15v8" />
                  </svg>
                  <div style={{ fontSize: 14, color: "#444", fontFamily: "'DM Mono',monospace", textAlign: "center" }}>
                    Visualização 3D desativada para melhor performance
                  </div>
                  {comp && vizTab === "surface" && (
                    <div style={{ marginTop: 12, padding: 16, background: "#111", borderRadius: 8, border: "1px solid #1a1a1a", width: "100%", maxWidth: 500 }}>
                      <div style={{ fontSize: 10, color: "#555", fontFamily: "'DM Mono',monospace", letterSpacing: 1.5, marginBottom: 10 }}>RESUMO RÁPIDO (sem 3D)</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                        <Met label="FAIR VALUE" value={comp.price1.toFixed(4)} color="#f5c518" small />
                        <Met label="MERCADO" value={mkt.toFixed(4)} color="#888" small />
                        <Met label="SPREAD" value={`${comp.spread1 > 0 ? "+" : ""}${comp.spread1.toFixed(2)}%`} color={vc(comp.verdict1)} small />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 6, marginTop: 8 }}>
                        <Met label="Δ" value={comp.greeks.delta.toFixed(3)} color="#f5c518" small />
                        <Met label="Γ" value={comp.greeks.gamma.toFixed(4)} color="#00b4d8" small />
                        <Met label="Θ" value={comp.greeks.theta.toFixed(4)} color="#e94560" small />
                        <Met label="ν" value={comp.greeks.vega.toFixed(4)} color="#2ec4b6" small />
                        <Met label="ρ" value={comp.greeks.rho.toFixed(4)} color="#533483" small />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ padding: "4px 16px 8px", display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: "'DM Mono',monospace", color: "#333" }}>
              <span>{enable3D ? "◆ Sua opção" : "◇ 3D off"} · {isAm ? "Binomial CRR" : "BSM"}</span>
              <span>{ticker} · {optT.toUpperCase()} · K={strike} · σ={vol}%</span>
            </div>
          </div>

          {/* RIGHT RESIZER */}
          <div className={`resizer ${resizing === 'right' ? 'active' : ''}`} onMouseDown={() => setResizing('right')}>
            <div className="resizer-handle" />
          </div>

          {/* RIGHT RESULTS */}
          <div className="no-scroll" style={{ ...ST.pn, width: rightW, flexShrink: 0 }}>
            <div style={ST.sh}><span style={{ color: "#f5c518" }}>03</span> RESULTADO</div>
            {comp && (<div style={{ animation: "fadeUp 0.3s ease" }}>
              {/* Verdict */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid #1a1a1a" }}>
                <div>
                  <div style={{ fontSize: 9, color: "#444", letterSpacing: 1.5, fontFamily: "'DM Mono',monospace", marginBottom: 3 }}>VEREDITO {comp.label1}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: vc(comp.verdict1), fontFamily: "'Instrument Sans',sans-serif" }}>{comp.verdict1}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, color: "#444", letterSpacing: 1, fontFamily: "'DM Mono',monospace", marginBottom: 3 }}>SPREAD</div>
                  <div style={{ fontSize: 18, fontFamily: "'DM Mono',monospace", fontWeight: 500, color: vc(comp.verdict1) }}>{comp.spread1 > 0 ? "+" : ""}{comp.spread1.toFixed(2)}%</div>
                </div>
              </div>

              {/* Prices */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 12 }}>
                <Met label="MERCADO" value={mkt.toFixed(2)} color="#888" />
                <Met label={comp.label1} value={comp.price1.toFixed(2)} color="#f5c518" />
                <Met label={comp.label2} value={comp.price2.toFixed(2)} color="#00b4d8" />
              </div>
              {comp.mcSe > 0 && <div style={{ fontSize: 9, color: "#333", marginTop: 3, fontFamily: "'DM Mono',monospace", textAlign: "right" }}>MC±{comp.mcSe.toFixed(4)}</div>}

              {isAm && comp.earlyExPremium > 0.0001 && (<>
                <Sep />
                <div style={{ padding: "10px 12px", borderRadius: 6, background: "rgba(245,197,24,0.04)", border: "1px solid rgba(245,197,24,0.12)" }}>
                  <div style={{ fontSize: 9, color: "#555", letterSpacing: 1, fontFamily: "'DM Mono',monospace", marginBottom: 4 }}>PRÊMIO EXERCÍCIO ANTECIPADO</div>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "'DM Mono',monospace", color: "#f5c518" }}>R${comp.earlyExPremium.toFixed(4)}</span>
                  <span style={{ fontSize: 10, color: "#555", marginLeft: 8 }}>({(comp.earlyExPremium / comp.price1 * 100).toFixed(2)}%)</span>
                </div>
              </>)}

              <Sep />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <Met label="VOL HIST" value={`${vol.toFixed(1)}`} unit="%" color="#f5c518" small />
                <Met label="VOL IMPL" value={`${(comp.iv * 100).toFixed(1)}`} unit="%" color={comp.iv > sig ? "#e94560" : "#2ec4b6"} small />
              </div>

              <Sep />
              <div style={{ fontSize: 9, color: "#555", letterSpacing: 1.5, fontFamily: "'DM Mono',monospace", marginBottom: 6 }}>GREGAS {isAm ? "(FD)" : "(ANALÍTICAS)"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                {[{ l: "Delta", v: comp.greeks.delta, c: "#f5c518", f: 4 }, { l: "Gamma", v: comp.greeks.gamma, c: "#00b4d8", f: 5 },
                { l: "Theta", v: comp.greeks.theta, c: "#e94560", f: 5, u: "/du" }, { l: "Vega", v: comp.greeks.vega, c: "#2ec4b6", f: 5, u: "/1%" },
                { l: "Rho", v: comp.greeks.rho, c: "#533483", f: 5, u: "/1%" }
                ].map(g => <Met key={g.l} label={g.l} value={`${g.v >= 0 ? "+" : ""}${g.v.toFixed(g.f)}`} unit={g.u} color={g.c} small />)}
              </div>

              <Sep />

              {/* EXPAND MATH */}
              <button onClick={() => setShowMath(!showMath)} style={{
                width: "100%", padding: "10px 0", border: "1px solid #1a1a1a", borderRadius: 5,
                background: showMath ? "rgba(245,197,24,0.04)" : "transparent", color: showMath ? "#f5c518" : "#555",
                fontFamily: "'DM Mono',monospace", fontSize: 10, cursor: "pointer", letterSpacing: 1
              }}>
                {showMath ? "▾ OCULTAR" : "▸ EXPANDIR"} RACIOCÍNIO MATEMÁTICO
              </button>
              {showMath && <div style={{ marginTop: 10 }}><MathPanel S={spot} K={strike} T={T} r={r} sig={sig} type={optT} q={q} style={style} mkt={mkt} result={comp} /></div>}

              <div style={{ marginTop: 10, fontSize: 9, color: "#333", fontFamily: "'DM Mono',monospace", lineHeight: 1.8 }}>
                r_cont={`${(r * 100).toFixed(2)}%`} · q={`${(q * 100).toFixed(2)}%`} · T={T.toFixed(4)}a · ~{Math.round(days * 252 / 365)}DU
              </div>
            </div>)}
          </div>
        </div>
      )}
    </div>);
}

const ST = {
  root: { background: "#0a0a0a", height: "100vh", width: "100vw", overflow: "hidden", padding: "0 16px", fontFamily: "'Instrument Sans',sans-serif", color: "#ccc" },
  hd: { display: "flex", justifyContent: "space-between", alignItems: "center", height: 56, borderBottom: "1px solid #151515", marginBottom: 12, paddingTop: 8 },
  logo: { width: 40, height: 40, borderRadius: 7, border: "1px solid #f5c518", display: "flex", alignItems: "center", justifyContent: "center" },
  tabI: { background: "transparent", color: "#555", border: "none", padding: "6px 14px", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 500 },
  tabA: { background: "#1a1a1a", color: "#eee", border: "none", padding: "6px 14px", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600 },
  pn: { background: "#0e0e0e", borderRadius: 10, padding: 16, border: "1px solid #1a1a1a", overflowY: "auto", height: "100%" },
  sh: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 11, fontWeight: 600, color: "#555", fontFamily: "'DM Mono',monospace", letterSpacing: 1.5 },
  btn: { width: "100%", padding: "12px 0", border: "1px solid #f5c518", borderRadius: 5, background: "rgba(245,197,24,0.06)", color: "#f5c518", fontFamily: "'DM Mono',monospace", fontSize: 11, fontWeight: 500, letterSpacing: 2, cursor: "pointer" },
  th: { padding: "10px 8px", fontWeight: 600, fontSize: 10, letterSpacing: 1 },
  td: { padding: "8px 8px", whiteSpace: "nowrap", fontSize: 12 },
};