import React, { useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';

// Prompt input as a CodeMirror 6 editor (ticket #46), matching the production
// PromptInput. The overlay placeholder (home variant's stacked rotating lines)
// is passed in as a node so the rotation state stays with the owner; the editor
// itself only knows value/submit/Tab semantics.
//
// data-cy contract (load-bearing for cypress): the wrapper carries
// `prompt-textarea` — the e2e suite reaches the editable content through
// `[data-cy="prompt-textarea"] .cm-content` — and the inner div carries
// `prompt-input`. Enter (without Shift) submits; Shift-Enter inserts a newline
// via the default keymap. Tab is always consumed by the owner's onTabAccept —
// it accepts the rotating example while the doc is empty, and is a no-op once
// content exists (a plain Tab never inserts anything into the prompt).
const PromptEditor = ({ value, onChange, onSubmit, onTabAccept, disabled, placeholder, overlay }) => {
  // CodeMirror `extensions` must keep a stable identity across renders (a fresh
  // array forces a full reconfigure on every keystroke), while the handlers it
  // closes over change — so the keymap is built once against refs that always
  // point at the latest callbacks.
  const handlers = useRef({});
  handlers.current = { onSubmit, onTabAccept };

  const extensions = useMemo(
    () => [
      // Prec.highest: the prompt bindings must win over the default keymap's
      // Enter (insert newline) and Tab (indentMore) — plain array order proved
      // not to guarantee that for the Tab binding.
      Prec.highest(
        keymap.of([
          {
            key: 'Enter',
            run: () => {
              handlers.current.onSubmit();
              return true;
            },
          },
          {
            key: 'Tab',
            run: (view) => {
              if (!handlers.current.onTabAccept) return false;
              return handlers.current.onTabAccept(view.state.doc.toString());
            },
          },
        ])
      ),
      keymap.of(defaultKeymap),
      EditorView.lineWrapping,
    ],
    []
  );

  return (
    <div className="tw:relative tw:min-w-0 tw:flex-1" data-cy="prompt-textarea">
      {overlay}
      <div data-cy="prompt-input">
        <CodeMirror
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          extensions={extensions}
          basicSetup={false}
          readOnly={disabled}
          className="tw-bg-transparent [&_.cm-editor]:tw-bg-transparent [&_.cm-gutters]:tw-hidden [&_.cm-content]:tw-px-0 [&_.cm-content]:tw-py-0 [&_.cm-content]:tw-text-sm [&_.cm-content]:tw-text-text-default [&_.cm-placeholder]:tw-text-text-placeholder"
          style={{ backgroundColor: 'transparent' }}
        />
      </div>
    </div>
  );
};

export default PromptEditor;
