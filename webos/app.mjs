import {drawBoard, drawDrape} from './webos/view.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const extension = '.clothcraft.json';
const maxBytes = 2 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', {fatal:true});

function element(tag, text = '', properties = {}) {
  const node = Object.assign(document.createElement(tag), properties);
  node.textContent = text;
  return node;
}

function pathName(value) {
  const path = String(value).replace(/^\//,'');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) {
    throw Error('Choose a file in your Files workspace.');
  }
  return path;
}

export function mount(host) {
  const session = host.session(), owner = host.storage.workspaceOwner();
  const abort = new AbortController(), {signal} = abort;
  const app = element('section','',{className:'window-content clothcraft-app'});
  const style = element('link','',{rel:'stylesheet',href:new URL('./webos/workspace.css',import.meta.url).href});
  const header = element('div','',{className:'clothcraft-toolbar'}), controls = element('div','',{className:'clothcraft-controls'});
  const status = element('div','Opening ClothCraft…',{className:'clothcraft-status'});
  status.setAttribute('role','status');
  const patternArea = element('section','',{className:'clothcraft-pattern'});
  const drapeArea = element('section','',{className:'clothcraft-drape'});
  const views = element('div','',{className:'clothcraft-views'});
  const board = document.createElementNS('http://www.w3.org/2000/svg','svg');
  board.setAttribute('aria-label','Pattern board');
  const canvas = element('canvas');
  canvas.setAttribute('aria-label','Garment drape preview');
  const metrics = element('output','Physical time 0 s');
  const worker = new Worker(new URL('./webos/worker.mjs',import.meta.url),{type:'module'});
  const pendingMessages = new Map(), buttons = [];
  let requestId = 0, view, avatar, selected, ctx, binding, pending, unregister, paused = false, dirty = false;
  let alive = true, initialized = false, playing = false, timer;

  function check() {
    if (signal.aborted || session !== host.session() || owner !== host.storage.workspaceOwner() || (ctx && !ctx.valid())) {
      throw new DOMException('This Files session ended.', 'AbortError');
    }
    if (paused) throw Error('Files are being transferred.');
  }

  function ask(op,value) {
    check();
    if (!alive) return Promise.reject(Error('The ClothCraft worker stopped. Reopen the editor to restart it.'));
    return new Promise((resolve,reject) => {
      const id = ++requestId;
      pendingMessages.set(id,{resolve,reject});
      worker.postMessage({id,op,value});
    });
  }
  worker.addEventListener('message', ({data:{id,data,error}}) => {
    const request = pendingMessages.get(id);
    if (!request) return;
    pendingMessages.delete(id);
    if (error) request.reject(Error(error));
    else request.resolve(data);
  });
  worker.addEventListener('error', () => {
    alive = false;
    for (const request of pendingMessages.values()) request.reject(Error('The ClothCraft worker stopped.'));
    pendingMessages.clear();
  });

  function text(text) { status.textContent = text; }
  function button(parent,label,fn) {
    const b=element('button',label,{type:'button',disabled:true});
    b.addEventListener('click',fn,{signal});
    buttons.push(b);
    parent.append(b);
    return b;
  }
  function field(parent,label,input) {
    const node=element('label',label);
    input.setAttribute('aria-label',label);
    node.append(input); parent.append(node); return input;
  }
  const number = (value, step = '1') => element('input','',{type:'number',value:String(value),step});
  function options(select, pairs, value) {
    select.replaceChildren(...pairs.map(([key,label]) => element('option',label,{value:key})));
    if (pairs.some(([key]) => key === value)) select.value=value;
  }
  function stateButtons() {
    for (const b of buttons) b.disabled = !initialized || !!pending || paused;
    if (view) {
      undo.disabled ||= !view.canUndo;
      redo.disabled ||= !view.canRedo;
      sew.disabled ||= !edgeA.options.length || !edgeB.options.length;
      unsew.disabled ||= view.seams.length===0;
      anchorButton.disabled ||= !anchor.options.length;
    }
    play.textContent=playing ? 'Pause' : 'Simulate';
  }
  function pause() { playing=false; clearTimeout(timer); stateButtons(); }
  function run(operation) {
    if (pending) return pending;
    pause();
    const work = Promise.resolve().then(operation);
    pending=work;
    stateButtons();
    return work.catch(error => text(error.status===409 ? 'File changed in Files. Use Save as to keep this revision.' : error.message))
      .finally(() => { pending=null; stateButtons(); });
  }
  async function edit(value) {
    const result=await ask('edit',value);
    dirty=true;
    setView(result.view,result.selected ?? selected);
    text('Unsaved garment changes');
  }

  button(header,'Open',() => run(open));
  button(header,'Save',() => run(() => save(false)));
  button(header,'Save as',() => run(() => save(true)));
  const template=field(header,'Template',element('select'));
  options(template,[['tshirt','T-shirt'],['dress','Dress']],'tshirt');
  button(header,'New garment',() => run(async () => {
    if (!(await discard())) return;
    const result=await ask('new',template.value);
    binding=null;
    host.desktop.updateAccountFileBinding(host.w,{owner,path:null,sha256:null});
    dirty=false; setView(result.view); text('New garment');
  }));
  const undo=button(header,'Undo',() => run(() => history('undo')));
  const redo=button(header,'Redo',() => run(() => history('redo')));
  async function history(op) {
    const result=await ask(op);
    dirty=true; setView(result.view,selected); text('Unsaved garment changes');
  }

  const play=button(drapeArea,'Simulate',() => {
    if (playing) { pause(); return; }
    playing=true; stateButtons();
    void loop();
  });
  button(drapeArea,'Step simulation',() => run(step));
  button(drapeArea,'Reset simulation',() => run(async () => {
    const result=await ask('reset'); setView(result.view,selected);
  }));
  const yaw=field(drapeArea,'Rotate view',element('input','',{type:'range',min:'-180',max:'180',value:'17'}));
  yaw.addEventListener('input', renderDrape, {signal});
  drapeArea.append(metrics, canvas);

  const panelSelect=field(patternArea,'Pattern piece',element('select'));
  panelSelect.addEventListener('change',() => choose(panelSelect.value),{signal});
  patternArea.append(board);
  const boardX=field(controls,'Board X (mm)',number(0));
  const boardY=field(controls,'Board Y (mm)',number(0));
  const rotation=field(controls,'Board angle (°)',number(0));
  button(controls,'Apply layout',() => run(() => edit({
    kind:'layout',panel:selected,x:boardX.valueAsNumber/1000,y:boardY.valueAsNumber/1000,rotation:rotation.valueAsNumber,
  })));
  const placeX=field(controls,'Placement X (mm)',number(0));
  const placeY=field(controls,'Placement Y (mm)',number(0));
  const placeZ=field(controls,'Placement Z (mm)',number(0));
  button(controls,'Apply placement',() => run(() => edit({
    kind:'place',panel:selected,x:placeX.valueAsNumber/1000,y:placeY.valueAsNumber/1000,z:placeZ.valueAsNumber/1000,
  })));
  const anchor=field(controls,'Contour point',element('select'));
  const anchorX=field(controls,'Point X (mm)',number(0));
  const anchorY=field(controls,'Point Y (mm)',number(0));
  anchor.addEventListener('change',showAnchor,{signal});
  const anchorButton=button(controls,'Move point',() => run(() => edit({
    kind:'move_anchor',panel:selected,anchor:Number(anchor.value),x:anchorX.valueAsNumber/1000,y:anchorY.valueAsNumber/1000,
  })));
  const newWidth=field(controls,'New width (mm)',number(180));
  const newHeight=field(controls,'New height (mm)',number(260));
  button(controls,'Add rectangle',() => run(() => edit({
    kind:'add_rectangle',x:0,y:0,width:newWidth.valueAsNumber/1000,height:newHeight.valueAsNumber/1000,
  })));
  button(controls,'Remove piece',() => run(async () => {
    if (await host.ui.confirm('Remove the selected pattern piece?',{confirmLabel:'Remove',signal})) {
      await edit({kind:'remove_panel',panel:selected});
    }
  }));
  const edgeA=field(controls,'Seam edge A',element('select'));
  const edgeB=field(controls,'Seam edge B',element('select'));
  const reverse=field(controls,'Reverse seam direction',element('input','',{type:'checkbox',checked:true}));
  const ease=field(controls,'Allow unequal edges',element('input','',{type:'checkbox'}));
  const sew=button(controls,'Sew edges',() => run(() => edit({
    kind:'sew',a:JSON.parse(edgeA.value),b:JSON.parse(edgeB.value),reverse:reverse.checked,ease:ease.checked,
  })));
  const seams=field(controls,'Existing seam',element('select'));
  const unsew=button(controls,'Remove seam',() => run(() => edit({kind:'remove_seam',seam:seams.value})));
  views.append(patternArea,drapeArea);
  app.append(style,header,status,views,controls);
  const resize=new ResizeObserver(renderDrape);
  resize.observe(canvas);

  async function step() {
    const data=await ask('step');
    view.points=data.points; view.time=data.time;
    metrics.textContent='Physical time '+data.time.toFixed(3)+' s · '+data.contacts+' contacts';
    renderDrape();
  }
  async function loop() {
    if (!playing || signal.aborted) return;
    try { await step(); }
    catch (error) { pause(); text(error.message); return; }
    if (playing) timer=setTimeout(loop,0);
  }
  function renderDrape() { if (avatar && view) drawDrape(canvas,avatar,view,Number(yaw.value)); }
  function showAnchor() {
    const point=view?.panels.find(panel => panel.id===selected)?.anchors[Number(anchor.value)];
    if (point) [anchorX.value,anchorY.value]=point.map(x => (x*1000).toFixed(1));
  }
  function choose(id) {
    const panel=view.panels.find(row => row.id===id);
    if (!panel) return;
    selected=id; panelSelect.value=id;
    [boardX.value,boardY.value]=panel.origin.map(x => (x*1000).toFixed(1));
    rotation.value=String(panel.rotation);
    [placeX.value,placeY.value,placeZ.value]=panel.placement.map(x => (x*1000).toFixed(1));
    options(anchor,panel.anchors.map((_,i) => [String(i),'Point '+(i+1)]),anchor.value);
    showAnchor();
    drawBoard(board,view,selected,choose);
    stateButtons();
  }
  function setView(next, selection) {
    view=next;
    options(panelSelect,view.panels.map(panel => [panel.id,panel.name]),selection);
    options(seams,view.seams.map(row => [row.id,row.id]),seams.value);
    const edges=view.panels.flatMap(panel => panel.edges.map(edge => [
      JSON.stringify({panel:panel.id,side:panel.anchors.length?'top':edge.name.toLowerCase(),range:[0,1],
        ...(panel.anchors.length?{edge:edge.name}:{})}),
      panel.name+' / '+edge.name,
    ]));
    options(edgeA,edges,edgeA.value);
    options(edgeB,edges,edgeB.value);
    choose(panelSelect.value);
    metrics.textContent='Physical time '+view.time.toFixed(3)+' s';
    renderDrape();
  }

  function bind(path,sha256) {
    if (!hashPattern.test(sha256)) throw Error('Files did not confirm the saved revision.');
    binding={path,sha256};
    host.desktop.updateAccountFileBinding(host.w,{owner,...binding});
  }
  async function discard() {
    return !dirty || await host.ui.confirm('Discard the current unsaved garment changes?',{confirmLabel:'Discard',signal});
  }
  async function load(path,expected) {
    check();
    const file=await ctx.files.read(path,{signal});
    check();
    if (expected && expected!==file.sha256) throw Error('The garment changed in Files. Reopen its current revision.');
    if (file.data.byteLength > maxBytes) throw Error('This garment exceeds the 2 MiB project limit.');
    const result=await ask('open',decoder.decode(file.data));
    check();
    bind(path,file.sha256);
    setView(result.view); dirty=false;
    text('Opened '+path.split('/').at(-1));
  }
  async function open() {
    if (!(await discard())) return;
    const selectedFile=await host.storage.pickWorkspaceFile({extensions:['.json'],signal});
    if (selectedFile) await load(pathName(selectedFile));
  }
  async function save(as) {
    check();
    let path=binding?.path;
    if (as || !path) {
      const folder=await host.storage.pickWorkspaceFile({foldersOnly:true,signal});
      if (!folder) return;
      let name=await host.ui.prompt('File name',{title:'Save ClothCraft garment',value:'Garment'+extension,confirmLabel:'Save',signal});
      if (name==null) return;
      name=name.trim();
      if (!name || /[/\\\x00-\x1f]/.test(name)) throw Error('Enter one garment file name.');
      if (!name.toLowerCase().endsWith(extension)) name+=extension;
      path=pathName((folder==='/'?'':folder+'/')+name);
    }
    const json=await ask('document');
    check();
    const revision=await ctx.files.write(path,new Blob([json],{type:'application/json'}),binding?.path===path?binding.sha256:null,{signal});
    check();
    bind(path,revision.sha256); dirty=false;
    text('Saved '+path.split('/').at(-1));
  }
  const ready=(async () => {
    ctx=await host.storage.workspaceFileContext();
    check();
    if (ctx.owner!==owner) throw Error('This editor belongs to another Files workspace.');
    unregister=ctx.registerFileWriter?.(async () => {
      pause();
      if (pending) await pending;
      if (dirty) throw Error('Save your ClothCraft garment before transferring Files.');
      paused=true; app.inert=true; stateButtons();
      return () => { paused=false; app.inert=false; stateButtons(); };
    });
    const initial=await ask('init');
    avatar=initial.avatar;
    setView(initial.view);
    const file=host.w.launchContext;
    if (file) {
      if (file.storage!=='account' || file.owner!==owner) throw Error('Open a garment from your Files.');
      await load(pathName(file.path),file.restore?null:file.sha256);
    } else text('ClothCraft is ready');
    initialized=true; stateButtons();
  })();
  ready.catch(error => text(error.message));
  return {
    element:app,ready,focus:() => panelSelect.focus(),
    inspect:() => ({ready:!!view,path:binding?.path??null,pieces:view?.panels.length??0,time:view?.time??0,dirty}),
    async requestClose() { pause(); if (pending) await pending.catch(() => {}); return discard(); },
    dispose() {
      pause(); unregister?.(); abort.abort(); resize.disconnect(); worker.terminate();
      for (const request of pendingMessages.values()) request.reject(new DOMException('ClothCraft closed.','AbortError'));
      pendingMessages.clear();
    },
  };
}
