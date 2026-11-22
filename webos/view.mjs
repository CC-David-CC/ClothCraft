const ns = 'http://www.w3.org/2000/svg';
const colors = ['#63b3a2', '#8cb0e8', '#df9e73', '#bba5d8', '#a5c381'];

function svg(tag, properties) {
  const node = document.createElementNS(ns, tag);
  for (const [key,value] of Object.entries(properties)) node.setAttribute(key, value);
  return node;
}

function boardPoint(panel, point) {
  const angle = panel.rotation * Math.PI / 180;
  const [x,y] = point;
  return [
    panel.origin[0] + Math.cos(angle) * x - Math.sin(angle) * y,
    panel.origin[1] + Math.sin(angle) * x + Math.cos(angle) * y,
  ];
}

export function drawBoard(board, view, selected, choose) {
  board.replaceChildren();
  let lowX = Infinity, lowY = Infinity, highX = -Infinity, highY = -Infinity;
  const project = (panel, point) => {
    const [x,y] = boardPoint(panel, point);
    lowX = Math.min(lowX,x); lowY = Math.min(lowY,y);
    highX = Math.max(highX,x); highY = Math.max(highY,y);
    return [x,y];
  };
  const pointText = point => point.map(v => v.toFixed(5)).join(' ');
  view.panels.forEach((panel,index) => {
    const group = svg('g', {'data-piece':panel.id, role:'button', tabindex:0, 'aria-label':panel.name,
      'aria-pressed':String(panel.id === selected)});
    const triangles = panel.faces.map(face => face.map(id => project(panel,view.rest[id])));
    const path = triangles.map(face => 'M ' + face.map(pointText).join(' L ') + ' Z').join(' ');
    group.append(svg('path',{d:path,fill:colors[index % colors.length],opacity:panel.id === selected ? 0.94 : 0.72}));
    for (const edge of panel.edges) {
      const points = edge.points.map(point => pointText(project(panel,point))).join(' ');
      group.append(svg('polyline',{points,fill:'none',stroke:'#203936','stroke-width':panel.id === selected ? 2.7 : 1.4,
        'vector-effect':'non-scaling-stroke'}));
    }
    group.addEventListener('click', () => choose(panel.id));
    group.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      choose(panel.id);
    });
    board.append(group);
  });
  const width = Math.max(highX-lowX,0.1), height = Math.max(highY-lowY,0.1);
  const margin = Math.max(width,height)*0.12;
  board.setAttribute('viewBox', [lowX-margin,lowY-margin,width+2*margin,height+2*margin].join(' '));
}

export function drawDrape(canvas, avatar, view, angle) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
  if (width < 1 || height < 1) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#192624';
  ctx.fillRect(0,0,width,height);
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const rotate = ([x,y,z]) => [x*cos+z*sin, -y, z*cos-x*sin];
  const body = avatar.points.map(rotate);
  const cloth = view.points.map(rotate);
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const points of [body,cloth]) for (const [x,y] of points) {
    xMin = Math.min(xMin,x); xMax = Math.max(xMax,x);
    yMin = Math.min(yMin,y); yMax = Math.max(yMax,y);
  }
  const scale = 0.86 * Math.min(width / Math.max(xMax-xMin,0.1), height / Math.max(yMax-yMin,0.1));
  const project = ([x,y]) => [width/2 + (x-(xMin+xMax)/2)*scale, height/2 + (y-(yMin+yMax)/2)*scale];
  const layers = [];
  function layer(points, faces, fill, stroke) {
    for (const face of faces) {
      const triangle = face.map(i => points[i]);
      layers.push({triangle, fill, stroke, depth:triangle.reduce((a,p) => a+p[2],0)});
    }
  }
  layer(body,avatar.faces,'#63746d',null);
  view.panels.forEach((panel,index) => layer(cloth,panel.faces,colors[index % colors.length],'#304b45'));
  layers.sort((a,b) => a.depth-b.depth);
  for (const {triangle,fill,stroke} of layers) {
    const [a,b,c] = triangle.map(project);
    ctx.beginPath();
    ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.45 * ratio;
      ctx.stroke();
    }
  }
}
