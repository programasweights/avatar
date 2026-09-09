import type { GLTFLoader } from "three-stdlib";

const configured = new WeakSet<GLTFLoader>();

function temporaryFailure(error: unknown): boolean {
  if (error instanceof TypeError)
    return /fetch|network|load failed/i.test(error.message);
  const status = (error as { response?: { status?: number } } | null)?.response
    ?.status;
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
}

// A failed Suspense load is cached until cleared. Retry a transient download
// before it reaches React, without retrying missing or malformed characters.
export function retryCharacterDownloads(loader: GLTFLoader) {
  if (configured.has(loader)) return;
  configured.add(loader);
  const load = loader.load.bind(loader);
  loader.load = (url, onLoad, onProgress, onError) => {
    let attempt = 0;
    const download = () =>
      load(url, onLoad, onProgress, (error) => {
        if (temporaryFailure(error) && attempt < 2) {
          const delay = [300, 1000][attempt++];
          setTimeout(download, delay);
        } else onError?.(error);
      });
    download();
  };
}
