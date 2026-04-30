// Fallback Azure VM SKU → {vCPU, ramGB} table for common sizes.
// Used only when the ARI workbook does not include explicit vCPU / RAM columns.
// Not exhaustive — unknown SKUs fall back to {vCPU: 2, ramGB: 8} and are flagged.

interface SkuSpec { vCPU: number; ramGB: number }

const TABLE: Record<string, SkuSpec> = {
  // B-series (burstable)
  'standard_b1ls':  { vCPU: 1,  ramGB: 0.5 },
  'standard_b1s':   { vCPU: 1,  ramGB: 1 },
  'standard_b1ms':  { vCPU: 1,  ramGB: 2 },
  'standard_b2s':   { vCPU: 2,  ramGB: 4 },
  'standard_b2ms':  { vCPU: 2,  ramGB: 8 },
  'standard_b4ms':  { vCPU: 4,  ramGB: 16 },
  'standard_b8ms':  { vCPU: 8,  ramGB: 32 },
  'standard_b12ms': { vCPU: 12, ramGB: 48 },
  'standard_b16ms': { vCPU: 16, ramGB: 64 },
  'standard_b20ms': { vCPU: 20, ramGB: 80 },

  // D-series v3 / v4 / v5
  'standard_d2s_v3':  { vCPU: 2,  ramGB: 8 },
  'standard_d4s_v3':  { vCPU: 4,  ramGB: 16 },
  'standard_d8s_v3':  { vCPU: 8,  ramGB: 32 },
  'standard_d16s_v3': { vCPU: 16, ramGB: 64 },
  'standard_d32s_v3': { vCPU: 32, ramGB: 128 },
  'standard_d64s_v3': { vCPU: 64, ramGB: 256 },
  'standard_d2s_v4':  { vCPU: 2,  ramGB: 8 },
  'standard_d4s_v4':  { vCPU: 4,  ramGB: 16 },
  'standard_d8s_v4':  { vCPU: 8,  ramGB: 32 },
  'standard_d16s_v4': { vCPU: 16, ramGB: 64 },
  'standard_d32s_v4': { vCPU: 32, ramGB: 128 },
  'standard_d2s_v5':  { vCPU: 2,  ramGB: 8 },
  'standard_d4s_v5':  { vCPU: 4,  ramGB: 16 },
  'standard_d8s_v5':  { vCPU: 8,  ramGB: 32 },
  'standard_d16s_v5': { vCPU: 16, ramGB: 64 },
  'standard_d32s_v5': { vCPU: 32, ramGB: 128 },
  'standard_d64s_v5': { vCPU: 64, ramGB: 256 },
  'standard_d96s_v5': { vCPU: 96, ramGB: 384 },

  // E-series (memory-optimised)
  'standard_e2s_v3':   { vCPU: 2,  ramGB: 16 },
  'standard_e4s_v3':   { vCPU: 4,  ramGB: 32 },
  'standard_e8s_v3':   { vCPU: 8,  ramGB: 64 },
  'standard_e16s_v3':  { vCPU: 16, ramGB: 128 },
  'standard_e32s_v3':  { vCPU: 32, ramGB: 256 },
  'standard_e64s_v3':  { vCPU: 64, ramGB: 432 },
  'standard_e2s_v5':   { vCPU: 2,  ramGB: 16 },
  'standard_e4s_v5':   { vCPU: 4,  ramGB: 32 },
  'standard_e8s_v5':   { vCPU: 8,  ramGB: 64 },
  'standard_e16s_v5':  { vCPU: 16, ramGB: 128 },
  'standard_e32s_v5':  { vCPU: 32, ramGB: 256 },
  'standard_e64s_v5':  { vCPU: 64, ramGB: 512 },
  'standard_e96s_v5':  { vCPU: 96, ramGB: 672 },

  // F-series (compute-optimised)
  'standard_f2s_v2':  { vCPU: 2,  ramGB: 4 },
  'standard_f4s_v2':  { vCPU: 4,  ramGB: 8 },
  'standard_f8s_v2':  { vCPU: 8,  ramGB: 16 },
  'standard_f16s_v2': { vCPU: 16, ramGB: 32 },
  'standard_f32s_v2': { vCPU: 32, ramGB: 64 },
  'standard_f64s_v2': { vCPU: 64, ramGB: 128 },
  'standard_f72s_v2': { vCPU: 72, ramGB: 144 },

  // M-series (huge memory)
  'standard_m8ms':    { vCPU: 8,   ramGB: 218 },
  'standard_m16ms':   { vCPU: 16,  ramGB: 437 },
  'standard_m32ms':   { vCPU: 32,  ramGB: 875 },
  'standard_m64ms':   { vCPU: 64,  ramGB: 1750 },
  'standard_m128ms':  { vCPU: 128, ramGB: 3892 },

  // A / DS legacy
  'standard_a1_v2':  { vCPU: 1,  ramGB: 2 },
  'standard_a2_v2':  { vCPU: 2,  ramGB: 4 },
  'standard_a4_v2':  { vCPU: 4,  ramGB: 8 },
  'standard_a8_v2':  { vCPU: 8,  ramGB: 16 },
  'standard_ds1_v2': { vCPU: 1,  ramGB: 3.5 },
  'standard_ds2_v2': { vCPU: 2,  ramGB: 7 },
  'standard_ds3_v2': { vCPU: 4,  ramGB: 14 },
  'standard_ds4_v2': { vCPU: 8,  ramGB: 28 },
  'standard_ds5_v2': { vCPU: 16, ramGB: 56 },
};

export function lookupSku(sku: string): { vCPU: number; ramGB: number; known: boolean } {
  const key = sku.trim().toLowerCase().replace(/\s+/g, '');
  const hit = TABLE[key];
  if (hit) return { ...hit, known: true };

  // Heuristic fallback: parse a digit run after the family letter as vCPU,
  // give it a reasonable RAM ratio per family.
  const m = /^standard_([a-z]+)(\d+)/i.exec(key);
  if (m) {
    const family = m[1].toLowerCase();
    const n = parseInt(m[2], 10);
    if (Number.isFinite(n) && n > 0) {
      const ratio =
        family.startsWith('e') || family.startsWith('m') ? 8 :
        family.startsWith('f') ? 2 : 4;
      return { vCPU: n, ramGB: n * ratio, known: false };
    }
  }
  return { vCPU: 2, ramGB: 8, known: false };
}
