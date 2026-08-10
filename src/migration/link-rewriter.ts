export interface TextEdit {
  startOffset: number;
  endOffset: number;
  expected: string;
  replacement: string;
}

export class StaleTextEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleTextEditError';
  }
}

export function splitLinkSubpath(target: string): { linkpath: string; subpath: string } {
  const hashIndex = target.indexOf('#');
  if (hashIndex === -1) return { linkpath: target, subpath: '' };
  return {
    linkpath: target.slice(0, hashIndex),
    subpath: target.slice(hashIndex),
  };
}

function findAliasSeparator(inner: string): number {
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] !== '|') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && inner[cursor] === '\\'; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

export function rewriteWikilinkOriginal(
  original: string,
  replacementTarget: string,
): string | null {
  if (original.startsWith('![[') || !original.startsWith('[[') || !original.endsWith(']]')) {
    return null;
  }

  const inner = original.slice(2, -2);
  const aliasIndex = findAliasSeparator(inner);
  const alias = aliasIndex === -1 ? '' : inner.slice(aliasIndex);
  return `[[${replacementTarget}${alias}]]`;
}

export function applyTextEdits(content: string, edits: TextEdit[]): string {
  const ascending = [...edits].sort((left, right) => left.startOffset - right.startOffset);

  for (let index = 0; index < ascending.length; index += 1) {
    const edit = ascending[index];
    if (
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset ||
      edit.endOffset > content.length
    ) {
      throw new StaleTextEditError(`Invalid edit range ${edit.startOffset}:${edit.endOffset}`);
    }
    if (index > 0 && edit.startOffset < ascending[index - 1].endOffset) {
      throw new StaleTextEditError('Text edits overlap');
    }
    const actual = content.slice(edit.startOffset, edit.endOffset);
    if (actual !== edit.expected) {
      throw new StaleTextEditError(
        `Expected ${JSON.stringify(edit.expected)} at ${edit.startOffset}:${edit.endOffset}, found ${JSON.stringify(actual)}`,
      );
    }
  }

  let result = content;
  for (const edit of ascending.reverse()) {
    result = result.slice(0, edit.startOffset) + edit.replacement + result.slice(edit.endOffset);
  }
  return result;
}
