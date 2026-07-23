import { App } from "obsidian";
import AmazingMarvinPlugin from "./main";
import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';

const COMPLETED_AM_TASK = /^\s*[-*+]\s\[[xX]\]\s\[⚓\]\(https:\/\/app\.amazingmarvin\.com\/#t=([^)\s]+)/;

export function amTaskWatcher(_app: App, plugin: AmazingMarvinPlugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(public view: EditorView) {
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) {
          return;
        }
        update.changes.iterChanges((fromA, _toA, _fromB, _toB, change) => {
          //only match if the change is on an AM task and it's a completed task
          let line = update.state.doc.lineAt(fromA).text;
          const match = line.match(COMPLETED_AM_TASK);
          if (match && match[1]) {
            void plugin.markDone(match[1]).catch((error) => {
              console.error("Could not mark Amazing Marvin task as done:", error);
            });
          }
        });
      }
    },
    {
    }
  );
}
