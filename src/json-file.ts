import fs from 'node:fs/promises';

const MOJIBAKE = /(?:Ã[\u0080-\u00bf]|Â[\u0080-\u00bf]|â€|ðŸ)/u;

export function parseJsonBytes<T>(bytes: Uint8Array, label: string): T {
  const text = Buffer.from(bytes).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${label} no debe contener BOM; guárdalo como UTF-8 sin BOM.`);
  if (text.includes('\uFFFD')) throw new Error(`${label} contiene caracteres de reemplazo; revisa su codificación UTF-8.`);
  if (MOJIBAKE.test(text)) throw new Error(`${label} parece contener texto mal decodificado (mojibake); corrige el archivo antes de continuar.`);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${label} no es JSON válido: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function readJsonFile<T>(file: string, label: string): Promise<T> {
  return parseJsonBytes<T>(await fs.readFile(file), label);
}
