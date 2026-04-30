# ari-graph-demo

Drop an [Azure Resource Inventory](https://github.com/microsoft/ARI) `.xlsx`
into the page and walk around your estate as a Minecraft-style fabric map.

- VM towers — height = composite of vCPU + RAM (normalized per file).
- Pads inside continents — subnets inside VNets.
- Edges — in-subnet wires, cross-subnet arches, rust-coloured VNet peering bridges.
- Controls — click to lock the pointer, then `WASD` + mouse-look, `Space` / `Shift`
  to fly up/down, `Ctrl` to sprint, `Esc` to release.
- 100% browser. Files never leave your machine; refresh wipes the world.

## Run

```sh
npm install
npm run dev          # http://localhost:5173
```

## Smoke test

```sh
node scripts/make-fixture.mjs   # generates fixtures/sample-ari.xlsx
node scripts/smoke.mjs          # parses + lays out, prints summary, asserts
```

## Build

```sh
npm run build && npm run preview
```

The output in `dist/` is fully static — drop it on any CDN.
