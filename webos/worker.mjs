import init, {Workspace} from './native/clothcraft.js';

const ready = init().then(() => new Workspace());

self.addEventListener('message', async ({data: {id, op, value}}) => {
  try {
    const editor = await ready;
    let data;
    switch (op) {
      case 'init':
        data = {avatar: JSON.parse(editor.avatar_json()), view: JSON.parse(editor.view())};
        break;
      case 'document':
        data = editor.document();
        break;
      case 'step':
        data = JSON.parse(editor.step());
        break;
      case 'new':
        editor.new_template(value);
        data = {view: JSON.parse(editor.view())};
        break;
      case 'open':
        editor.open(value);
        data = {view: JSON.parse(editor.view())};
        break;
      case 'reset':
        editor.reset_simulation();
        data = {view: JSON.parse(editor.view())};
        break;
      case 'edit': {
        const selected = editor.edit(JSON.stringify(value));
        data = {selected, view: JSON.parse(editor.view())};
        break;
      }
      case 'undo':
      case 'redo':
        editor.history(op === 'redo');
        data = {view: JSON.parse(editor.view())};
        break;
      default:
        throw Error('Unknown ClothCraft operation.');
    }
    self.postMessage({id, data});
  } catch (error) {
    self.postMessage({id, error: error instanceof Error ? error.message : String(error)});
  }
});
