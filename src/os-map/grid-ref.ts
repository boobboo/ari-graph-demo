// OSGB-style synthetic grid references.
// The canvas is divided into a 5×5 grid of 100km major squares (two-letter code),
// then each square is subdivided for the 6-digit reference.

const MAJOR_COLS = 5;
const MAJOR_ROWS = 5;

// Two-letter major square codes arranged W→E, N→S (like the real OS grid)
const MAJOR_LETTERS = [
  ['NA','NB','NC','ND','NE'],
  ['NF','NG','NH','NJ','NK'],
  ['NL','NM','NN','NO','NP'],
  ['SB','SC','SD','SE','SF'],
  ['SH','SJ','SK','SL','SM'],
];

export function toGridRef(
  x: number,
  y: number,
  mapW: number,
  mapH: number,
): string {
  // Major square (column west→east, row north→south)
  const col = Math.min(MAJOR_COLS - 1, Math.floor((x / mapW) * MAJOR_COLS));
  const row = Math.min(MAJOR_ROWS - 1, Math.floor((y / mapH) * MAJOR_ROWS));
  const letters = MAJOR_LETTERS[row]?.[col] ?? 'SJ';

  // 3-digit easting / northing within the major square (000–999)
  const subX = (x / mapW) * MAJOR_COLS - col;
  const subY = (y / mapH) * MAJOR_ROWS - row;
  const e = String(Math.min(999, Math.floor(subX * 1000))).padStart(3, '0');
  // Northing inverts: top of map = high northing
  const n = String(Math.min(999, Math.floor((1 - subY) * 1000))).padStart(3, '0');

  return `${letters}${e}${n}`;
}
