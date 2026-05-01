export function exportSvg(svg: SVGSVGElement, filename = 'azure-estate-map.svg'): void {
  const serializer = new XMLSerializer();
  const raw = serializer.serializeToString(svg);
  // Inject XML declaration + standalone so the file opens cleanly in Inkscape/Illustrator
  const blob = new Blob(
    ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n', raw],
    { type: 'image/svg+xml;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPng(svg: SVGSVGElement, filename = 'azure-estate-map.png'): void {
  const vb = svg.viewBox.baseVal;
  const w = vb.width  || svg.clientWidth  || 1200;
  const h = vb.height || svg.clientHeight || 840;

  const serializer = new XMLSerializer();
  const raw = serializer.serializeToString(svg);
  const svgBlob = new Blob([raw], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl  = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = (): void => {
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(svgUrl);

    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  };
  img.src = svgUrl;
}
