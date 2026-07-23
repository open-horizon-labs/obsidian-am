import { App } from "obsidian";
import AmazingMarvinPlugin from "./main";
import {
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { isNewlyCompletedMarvinTask } from "./marvin/taskLine";

export function amTaskWatcher(_app: App, plugin: AmazingMarvinPlugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(public view: EditorView) {
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) {
          return;
        }
        update.changes.iterChanges((fromA, _toA, fromB) => {
          const before = update.startState.doc.lineAt(fromA).text;
          const after = update.state.doc.lineAt(fromB).text;
          const taskId = isNewlyCompletedMarvinTask(before, after);
          if (taskId) {
            void plugin.markDone(taskId).catch((error) => {
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
