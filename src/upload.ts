export function setupUpload(opts: {
  drop: HTMLElement;
  input: HTMLInputElement;
  pick: HTMLButtonElement;
  onFile: (buf: ArrayBuffer, name: string) => void;
}) {
  const { drop, input, pick, onFile } = opts;

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    onFile(await f.arrayBuffer(), f.name);
    input.value = '';
  });

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    onFile(await f.arrayBuffer(), f.name);
  });
}
