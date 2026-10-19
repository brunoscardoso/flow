// VS Code-faithful Monaco themes (#126). The old "Stark" theme defined only 7
// syntax-token rules over vs-dark, so most code fell back to vs-dark defaults mixed
// with Stark accent hues — it read as a "weird", inconsistent theme. These are the
// full VS Code Default **Dark+** and **Light+** syntax palettes so code looks exactly
// like VS Code. A light/dark PAIR is defined; the applied one follows the app's color
// mode (dark today — the app has no light chrome yet — with a data-theme follow so the
// editor tracks the app automatically once a light mode ships). Monaco can't read CSS
// custom properties, so the colors are literal hex (the allowed exception).
import type * as Monaco from 'monaco-editor'

export const EDITOR_THEME_DARK = 'flow-dark'
export const EDITOR_THEME_LIGHT = 'flow-light'

export type EditorColorMode = 'dark' | 'light'

/** Map the app's color mode to the Monaco theme name. Anything but 'light' → dark. */
export function resolveEditorThemeName(mode: EditorColorMode): string {
  return mode === 'light' ? EDITOR_THEME_LIGHT : EDITOR_THEME_DARK
}

/** The editor color mode for an `<html data-theme>` value. The shell is dark-only
 *  today; a future light mode sets `data-theme="light"`, which this follows (#126).
 *  Pure (takes the raw attribute value) so it's node-jest-testable without the DOM. */
export function colorModeFromDataTheme(dataTheme: string | null | undefined): EditorColorMode {
  return dataTheme === 'light' ? 'light' : 'dark'
}

/**
 * The Monaco theme the git/review DIFF editor should use — the app's current editor
 * theme resolved from `<html data-theme>`. Monaco's theme is a GLOBAL singleton, so
 * a diff editor created with an unknown name (the removed 'flow-stark') made Monaco
 * fall back to the light `vs` theme and flipped the ALREADY-OPEN code editor to light
 * too (#453). Always one of the defined `flow-dark`/`flow-light` names — never the
 * dangling one. Pure → node-jest-testable.
 */
export function diffEditorThemeName(dataTheme: string | null | undefined): string {
  return resolveEditorThemeName(colorModeFromDataTheme(dataTheme))
}

// ── VS Code Default Dark+ syntax colors ──────────────────────────────────────
const DARK_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
  { token: 'string', foreground: 'CE9178' },
  { token: 'string.key.json', foreground: '9CDCFE' },
  { token: 'string.value.json', foreground: 'CE9178' },
  { token: 'number', foreground: 'B5CEA8' },
  { token: 'regexp', foreground: 'D16969' },
  { token: 'keyword', foreground: '569CD6' },
  { token: 'keyword.control', foreground: 'C586C0' },
  { token: 'keyword.operator', foreground: 'D4D4D4' },
  { token: 'operator', foreground: 'D4D4D4' },
  { token: 'delimiter', foreground: 'D4D4D4' },
  { token: 'type', foreground: '4EC9B0' },
  { token: 'type.identifier', foreground: '4EC9B0' },
  { token: 'namespace', foreground: '4EC9B0' },
  { token: 'struct', foreground: '4EC9B0' },
  { token: 'class', foreground: '4EC9B0' },
  { token: 'interface', foreground: '4EC9B0' },
  { token: 'enum', foreground: '4EC9B0' },
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'annotation', foreground: 'DCDCAA' },
  { token: 'variable', foreground: '9CDCFE' },
  { token: 'variable.predefined', foreground: '4FC1FF' },
  { token: 'constant', foreground: '4FC1FF' },
  { token: 'tag', foreground: '569CD6' },
  { token: 'attribute.name', foreground: '9CDCFE' },
  { token: 'attribute.value', foreground: 'CE9178' },
  { token: 'metatag', foreground: '569CD6' },
  { token: 'metatag.content.html', foreground: 'CE9178' },
  { token: 'attribute.value.html', foreground: 'CE9178' },
  { token: 'string.html', foreground: 'CE9178' },
  { token: 'invalid', foreground: 'F14C4C' },
]

// ── VS Code Default Light+ syntax colors ─────────────────────────────────────
const LIGHT_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '008000', fontStyle: 'italic' },
  { token: 'string', foreground: 'A31515' },
  { token: 'string.key.json', foreground: '0451A5' },
  { token: 'string.value.json', foreground: 'A31515' },
  { token: 'number', foreground: '098658' },
  { token: 'regexp', foreground: '811F3F' },
  { token: 'keyword', foreground: '0000FF' },
  { token: 'keyword.control', foreground: 'AF00DB' },
  { token: 'keyword.operator', foreground: '000000' },
  { token: 'operator', foreground: '000000' },
  { token: 'delimiter', foreground: '000000' },
  { token: 'type', foreground: '267F99' },
  { token: 'type.identifier', foreground: '267F99' },
  { token: 'namespace', foreground: '267F99' },
  { token: 'struct', foreground: '267F99' },
  { token: 'class', foreground: '267F99' },
  { token: 'interface', foreground: '267F99' },
  { token: 'enum', foreground: '267F99' },
  { token: 'function', foreground: '795E26' },
  { token: 'annotation', foreground: '795E26' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.predefined', foreground: '0070C1' },
  { token: 'constant', foreground: '0070C1' },
  { token: 'tag', foreground: '800000' },
  { token: 'attribute.name', foreground: 'E50000' },
  { token: 'attribute.value', foreground: '0451A5' },
  { token: 'metatag', foreground: '800000' },
  { token: 'metatag.content.html', foreground: 'A31515' },
  { token: 'attribute.value.html', foreground: '0451A5' },
  { token: 'string.html', foreground: 'A31515' },
  { token: 'invalid', foreground: 'CD3131' },
]

export const DARK_THEME_DATA: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: DARK_RULES,
  colors: {
    'editor.background': '#1E1E1E',
    'editor.foreground': '#D4D4D4',
    'editorCursor.foreground': '#AEAFAD',
    'editor.lineHighlightBackground': '#2A2A2A',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#C6C6C6',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorWhitespace.foreground': '#404040',
    'editorBracketMatch.background': '#0064001a',
    'editorBracketMatch.border': '#888888',
    'editorWidget.background': '#252526',
    'editorWidget.border': '#454545',
    'editorSuggestWidget.background': '#252526',
    'editorSuggestWidget.border': '#454545',
    'editorSuggestWidget.selectedBackground': '#04395E',
    'editorHoverWidget.background': '#252526',
    'editorHoverWidget.border': '#454545',
    'editorError.foreground': '#F14C4C',
    'editorWarning.foreground': '#CCA700',
    'editorInfo.foreground': '#3794FF',
    'diffEditor.insertedTextBackground': '#9bb95533',
    'diffEditor.removedTextBackground': '#ff000033',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#bfbfbf66',
    'input.background': '#3C3C3C',
    'input.border': '#3C3C3C',
    focusBorder: '#007FD4',
  },
}

export const LIGHT_THEME_DATA: Monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: LIGHT_RULES,
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#000000',
    'editorCursor.foreground': '#000000',
    'editor.lineHighlightBackground': '#F3F3F3',
    'editor.selectionBackground': '#ADD6FF',
    'editor.inactiveSelectionBackground': '#E5EBF1',
    'editorLineNumber.foreground': '#237893',
    'editorLineNumber.activeForeground': '#0B216F',
    'editorIndentGuide.background1': '#D3D3D3',
    'editorIndentGuide.activeBackground1': '#939393',
    'editorWhitespace.foreground': '#33333333',
    'editorBracketMatch.background': '#0064001a',
    'editorBracketMatch.border': '#B9B9B9',
    'editorWidget.background': '#F3F3F3',
    'editorWidget.border': '#C8C8C8',
    'editorSuggestWidget.background': '#F3F3F3',
    'editorSuggestWidget.border': '#C8C8C8',
    'editorSuggestWidget.selectedBackground': '#D6EBFF',
    'editorHoverWidget.background': '#F3F3F3',
    'editorHoverWidget.border': '#C8C8C8',
    'editorError.foreground': '#E51400',
    'editorWarning.foreground': '#BF8803',
    'editorInfo.foreground': '#1A85FF',
    'diffEditor.insertedTextBackground': '#9bb95533',
    'diffEditor.removedTextBackground': '#ff000033',
    'scrollbar.shadow': '#DDDDDD',
    'scrollbarSlider.background': '#64646466',
    'scrollbarSlider.hoverBackground': '#646464b3',
    'scrollbarSlider.activeBackground': '#00000066',
    'input.background': '#FFFFFF',
    'input.border': '#CECECE',
    focusBorder: '#0090F1',
  },
}
