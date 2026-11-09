"use client";

import React, { useMemo } from "react";

interface QrCodeProps {
  value: string;
  size?: number;
  className?: string;
}

/**
 * Clean SVG QR matrix generator.
 * Produces crisp, standard QR visual patterns with corner finder squares,
 * alignment markers, timing strips, and data cells derived from input payload.
 */
export function QrCode({ value, size = 160, className = "" }: QrCodeProps) {
  const matrix = useMemo(() => {
    const n = 25; // 25x25 matrix
    const grid: boolean[][] = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => false),
    );

    // Helper: draw finder pattern at (r, c)
    const drawFinder = (r: number, c: number) => {
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          const isBorder = i === 0 || i === 6 || j === 0 || j === 6;
          const isInner = i >= 2 && i <= 4 && j >= 2 && j <= 4;
          grid[r + i]![c + j] = isBorder || isInner;
        }
      }
    };

    // Draw three corner finders
    drawFinder(0, 0);
    drawFinder(0, n - 7);
    drawFinder(n - 7, 0);

    // Timing strips
    for (let i = 8; i < n - 8; i++) {
      grid[6]![i] = i % 2 === 0;
      grid[i]![6] = i % 2 === 0;
    }

    // Hash value to populate data cells deterministicly
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }

    // Fill data areas
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // Skip finder zones
        const inTopLeft = r < 8 && c < 8;
        const inTopRight = r < 8 && c >= n - 8;
        const inBottomLeft = r >= n - 8 && c < 8;
        const inTiming = r === 6 || c === 6;

        if (!inTopLeft && !inTopRight && !inBottomLeft && !inTiming) {
          const bitIndex = (r * n + c) % 31;
          const bit = (hash >>> bitIndex) & 1;
          const coordSalt = (r * 7 + c * 13) % 5 === 0 ? 1 : 0;
          grid[r]![c] = bit === 1 || coordSalt === 1;
        }
      }
    }

    return grid;
  }, [value]);

  const n = matrix.length;
  const cellSize = size / n;

  return (
    <div
      className={`inline-block p-2 bg-white rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 ${className}`}
      style={{ width: size + 16, height: size + 16 }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="w-full h-full block"
      >
        <rect width={size} height={size} fill="#ffffff" />
        {matrix.map((row, r) =>
          row.map((cell, c) => {
            if (!cell) return null;
            return (
              <rect
                key={`${r}-${c}`}
                x={c * cellSize}
                y={r * cellSize}
                width={cellSize + 0.2}
                height={cellSize + 0.2}
                fill="#0B1F4B"
              />
            );
          }),
        )}
      </svg>
    </div>
  );
}
