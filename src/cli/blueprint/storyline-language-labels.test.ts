/**
 * The pure label list the app re-exports (`storyline-language-labels.ts`) must
 * name exactly the readers the CLI has: the compiler's extensions and every
 * tree-sitter table, with the same ids and display names.
 */

import { posix } from 'node:path';
import { storylineLanguageOf } from './storyline.js';
import { STORYLINE_LANGUAGES } from './storyline-languages.js';
import {
  isStorylineExtensionPath,
  STORYLINE_LANGUAGE_LABELS,
  storylineLanguageBadge,
} from './storyline-language-labels.js';
import { hasStorylineReader } from './storyline-reader.js';

describe('storyline language labels', () => {
  it('lists every tree-sitter table with its id, name and extensions', () => {
    for (const table of STORYLINE_LANGUAGES) {
      const label = STORYLINE_LANGUAGE_LABELS.find((entry) => entry.id === table.id);
      expect(label).toEqual({ id: table.id, displayName: table.displayName, extensions: [...table.extensions] });
    }
  });

  it('lists the compiler languages, and nothing no reader covers', () => {
    for (const label of STORYLINE_LANGUAGE_LABELS) {
      for (const extension of label.extensions) {
        const file = `src/x${extension}`;
        expect(hasStorylineReader(file)).toBe(true);
        if (label.id === 'typescript' || label.id === 'javascript') expect(storylineLanguageOf(file)).toBe(label.id);
      }
    }
    const compilerLabels = STORYLINE_LANGUAGE_LABELS.filter((label) => label.id === 'typescript' || label.id === 'javascript');
    expect(compilerLabels).toHaveLength(2);
    // Every extension the readers cover is labelled.
    const labelled = new Set(STORYLINE_LANGUAGE_LABELS.flatMap((label) => label.extensions));
    for (const table of STORYLINE_LANGUAGES) for (const extension of table.extensions) expect(labelled.has(extension)).toBe(true);
  });

  it('answers paths and badges', () => {
    expect(isStorylineExtensionPath('a/b.py')).toBe(true);
    expect(isStorylineExtensionPath('a/B.TSX')).toBe(true);
    expect(isStorylineExtensionPath('a/b.ex')).toBe(false);
    expect(isStorylineExtensionPath('.eslintrc')).toBe(false);
    expect(isStorylineExtensionPath('Makefile')).toBe(false);
    expect(posix.extname('x.c++')).toBe('.c++');
    expect(isStorylineExtensionPath('x.c++')).toBe(true);
    expect(storylineLanguageBadge('typescript')).toBeNull();
    expect(storylineLanguageBadge('javascript')).toBeNull();
    expect(storylineLanguageBadge('python')).toBe('Python');
    expect(storylineLanguageBadge('mixed')).toBe('Mixed languages');
    expect(storylineLanguageBadge('klingon')).toBeNull();
  });
});
