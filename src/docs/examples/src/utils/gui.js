import GUI from 'lil-gui';
import { isPhone } from './device';

export let gui = new GUI();
export const dropTarget = document.querySelector('#dropzone');

// NOTE On phones the GUI starts closed, because it covers most of the screen
let guiClosed = isPhone;

export const getController = (id) =>
  gui.controllersRecursive().find((controller) => controller.property === id);

// NOTE Fields: { id, name, defaultValue, options | min + max + step, onChange, onFinishChange }, or { folder, children }
export const setGuiFields = (fields) => {
  gui.destroy();
  gui = new GUI();
  gui.open(!guiClosed);
  gui.onOpenClose((changedGui) => {
    if (changedGui === gui) {
      guiClosed = gui._closed;
    }
  });

  const guiState = {};

  const traverse = (level, fields) => {
    fields.forEach((field) => {
      if (field.folder) {
        traverse(level.addFolder(field.folder), field.children);

        return;
      }

      guiState[field.id] = field.defaultValue;

      const input = level.add(
        guiState,
        field.id,
        field.options || field.min,
        field.max,
        field.step
      );

      input.name(field.name);

      if (field.onChange) {
        input.onChange(field.onChange);
      }

      if (field.onFinishChange) {
        input.onFinishChange(field.onFinishChange);
      }
    });
  };

  traverse(gui, fields);
};
