"use client";

import { useEffect, useRef } from "react";

const BARS = 48;

/**
 * Lightweight canvas waveform. With `sample` it draws live frequency data from the voice session;
 * otherwise it synthesizes motion while someone is speaking on the scripted call.
 */
export function Waveform({
  active,
  speaker,
  sample,
}: {
  active: boolean;
  speaker: "agent" | "vendor" | null;
  sample?: () => Uint8Array;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ speaker, sample, active });
  useEffect(() => {
    state.current = { speaker, sample, active };
  }, [speaker, sample, active]);

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const levels = new Float32Array(BARS);
    let raf = 0;

    const draw = (t: number) => {
      const { speaker: who, sample: read, active: on } = state.current;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const data = read?.();
      for (let i = 0; i < BARS; i++) {
        let target = 0.04;
        if (on && data && data.length) {
          target = Math.max(0.04, data[Math.floor((i / BARS) * data.length)] / 255);
        } else if (on && who && !reduce) {
          const env = Math.sin((i / BARS) * Math.PI);
          target = 0.12 + env * (0.45 + 0.4 * Math.sin(t / 90 + i * 1.7) * Math.sin(t / 230 + i * 0.6));
        } else if (on) {
          target = 0.06 + 0.03 * Math.sin(t / 400 + i);
        }
        levels[i] += (Math.abs(target) - levels[i]) * 0.25;
      }

      const gap = 3;
      const bw = (w - gap * (BARS - 1)) / BARS;
      g.fillStyle = who === "vendor" ? "#e4ecf1" : on ? "#d6a23e" : "#233747";
      for (let i = 0; i < BARS; i++) {
        const bh = Math.max(2, levels[i] * h);
        g.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvas} className="my-3 h-14 w-full" aria-hidden />;
}
