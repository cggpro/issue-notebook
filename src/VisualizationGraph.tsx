import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, RotateCcw, X } from 'lucide-react';
import type { VisualizationGraph as GraphData } from '../shared/visualization';
import { Modal } from './components';

type NodeKind = GraphData['nodes'][number]['kind'];

const KIND_META: Record<NodeKind, { label: string }> = {
  step: { label: '步骤' },
  decision: { label: '判断' },
  problem: { label: '问题' },
  impact: { label: '影响' },
  expected: { label: '预期' },
  cause: { label: '原因' },
  frontend: { label: '前端' },
  backend: { label: '后端' },
};

/* Deterministic local layout: no graph dependency, no random seed.
   Edges that close a cycle are routed through lanes below the columns. */
const NODE_WIDTH = 186;
const PAD = 22;
const GAP_X = 64;
const GAP_Y = 22;
const LABEL_SIZE = 12.5;
const DETAIL_SIZE = 10.5;
const EDGE_LABEL_SIZE = 9.5;
const LABEL_LINE = 17;
const DETAIL_LINE = 14;
const INNER_WIDTH = NODE_WIDTH - 28;
const EDGE_LABEL_MAX = GAP_X - 16;
const MIN_ZOOM = 0.4;
const AUTO_FIT_MIN = 0.85;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.1;

const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function charWidth(char: string, size: number) {
  if (/\s/.test(char)) return size * 0.34;
  if (WIDE_CHAR.test(char)) return size;
  if (/[.,:;!'’|]/.test(char)) return size * 0.28;
  if (/[MW@#%&]/.test(char)) return size * 0.84;
  if (/[A-Z]/.test(char)) return size * 0.64;
  if (/[0-9]/.test(char)) return size * 0.56;
  return size * 0.54;
}

function measureText(text: string, size: number) {
  let width = 0;
  for (const char of text) width += charWidth(char, size);
  return width;
}

function ellipsize(text: string, size: number, maxWidth: number, always = false) {
  const suffix = always ? '…' : '';
  if (measureText(text + suffix, size) <= maxWidth) return text + suffix;
  const chars = [...text];
  while (chars.length && measureText(chars.join('').trimEnd() + '…', size) > maxWidth) chars.pop();
  return chars.join('').trimEnd() + '…';
}

function wrapAll(text: string, size: number, maxWidth: number) {
  if (!text.trim()) return [];
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const char of paragraph) {
      if (line && measureText(line + char, size) > maxWidth) {
        lines.push(line.trimEnd());
        line = char.trimStart();
      } else {
        line += char;
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
  }
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

function clipLines(lines: string[], max: number, size: number, maxWidth: number) {
  if (lines.length <= max) return lines;
  const clipped = lines.slice(0, max);
  clipped[max - 1] = ellipsize(clipped[max - 1], size, maxWidth, true);
  return clipped;
}

interface LaidNode {
  index: number;
  id: string;
  label: string;
  detail: string;
  kind: NodeKind;
  x: number;
  y: number;
  height: number;
  labelLines: string[];
  detailLines: string[];
}

interface LaidEdge {
  key: string;
  from: number;
  to: number;
  path: string;
  label: string;
  fullLabel: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
  back: boolean;
  self: boolean;
}

interface GraphLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
}

interface IndexedEdge {
  from: number;
  to: number;
  label: string;
  order: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits: number) => Number(value.toFixed(digits));

function roundedPath(points: Array<[number, number]>, radius = 12) {
  const d: string[] = [`M ${round(points[0][0], 1)} ${round(points[0][1], 1)}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const [px, py] = points[index - 1];
    const [cx, cy] = points[index];
    const [nx, ny] = points[index + 1];
    const inLength = Math.hypot(cx - px, cy - py);
    const outLength = Math.hypot(nx - cx, ny - cy);
    if (!inLength || !outLength) { d.push(`L ${round(cx, 1)} ${round(cy, 1)}`); continue; }
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const inX = cx - ((cx - px) / inLength) * r;
    const inY = cy - ((cy - py) / inLength) * r;
    const outX = cx + ((nx - cx) / outLength) * r;
    const outY = cy + ((ny - cy) / outLength) * r;
    d.push(`L ${round(inX, 1)} ${round(inY, 1)}`, `Q ${round(cx, 1)} ${round(cy, 1)} ${round(outX, 1)} ${round(outY, 1)}`);
  }
  const [lastX, lastY] = points[points.length - 1];
  d.push(`L ${round(lastX, 1)} ${round(lastY, 1)}`);
  return d.join(' ');
}

export function buildLayout(graph: GraphData): GraphLayout {
  const nodes = graph.nodes;
  const count = nodes.length;
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));

  const seen = new Set<string>();
  const edges: IndexedEdge[] = [];
  graph.edges.forEach((edge, order) => {
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from === undefined || to === undefined) return;
    const key = `${from}\u0000${to}\u0000${edge.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, label: edge.label, order });
  });

  const outgoing: number[][] = Array.from({ length: count }, () => []);
  edges.forEach((edge, index) => outgoing[edge.from].push(index));
  outgoing.forEach(list => list.sort((a, b) => edges[a].to - edges[b].to || edges[a].order - edges[b].order));

  // Depth-first order gives deterministic cycle removal for level assignment.
  const visitState = new Array<number>(count).fill(0);
  const discovery: number[] = [];
  const backEdges = new Set<number>();
  const visit = (current: number) => {
    visitState[current] = 1;
    discovery.push(current);
    for (const edgeIndex of outgoing[current]) {
      const target = edges[edgeIndex].to;
      if (visitState[target] === 1) backEdges.add(edgeIndex);
      else if (visitState[target] === 0) visit(target);
    }
    visitState[current] = 2;
  };
  for (let index = 0; index < count; index += 1) if (visitState[index] === 0) visit(index);
  const discoveryRank = new Map(discovery.map((nodeIndex, rank) => [nodeIndex, rank]));

  const indegree = new Array<number>(count).fill(0);
  edges.forEach((edge, index) => { if (!backEdges.has(index)) indegree[edge.to] += 1; });
  const queue = Array.from({ length: count }, (_, index) => index).filter(index => indegree[index] === 0);
  queue.sort((a, b) => (discoveryRank.get(a) ?? 0) - (discoveryRank.get(b) ?? 0));
  const level = new Array<number>(count).fill(0);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edgeIndex of outgoing[current]) {
      if (backEdges.has(edgeIndex)) continue;
      const target = edges[edgeIndex].to;
      level[target] = Math.max(level[target], level[current] + 1);
      indegree[target] -= 1;
      if (indegree[target] === 0) {
        queue.push(target);
        queue.sort((a, b) => (discoveryRank.get(a) ?? 0) - (discoveryRank.get(b) ?? 0));
      }
    }
  }

  // Isolated nodes and nodes left by the cycle fallback stay in the first
  // column instead of disappearing.
  const maxLevel = count ? Math.max(...level) : 0;
  const columns: number[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (let index = 0; index < count; index += 1) columns[level[index]].push(index);
  columns.forEach(column => column.sort((a, b) => (discoveryRank.get(a) ?? 0) - (discoveryRank.get(b) ?? 0)));

  const parents: number[][] = Array.from({ length: count }, () => []);
  const children: number[][] = Array.from({ length: count }, () => []);
  edges.forEach((edge, index) => {
    if (backEdges.has(index)) return;
    parents[edge.to].push(edge.from);
    children[edge.from].push(edge.to);
  });

  const reorder = (list: number[], positions: Map<number, number>, neighbors: number[][]) => {
    const ranked = list.map((nodeIndex, position) => {
      const values = neighbors[nodeIndex].map(neighbor => positions.get(neighbor)).filter((value): value is number => value !== undefined);
      return { nodeIndex, position, key: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : position };
    });
    ranked.sort((a, b) => a.key - b.key || a.position - b.position);
    return ranked.map(item => item.nodeIndex);
  };

  // A few barycenter passes reduce needless crossings while remaining stable.
  for (let pass = 0; pass < 4; pass += 1) {
    for (let columnIndex = 1; columnIndex < columns.length; columnIndex += 1) {
      columns[columnIndex] = reorder(columns[columnIndex], new Map(columns[columnIndex - 1].map((nodeIndex, position) => [nodeIndex, position])), parents);
    }
    for (let columnIndex = columns.length - 2; columnIndex >= 0; columnIndex -= 1) {
      columns[columnIndex] = reorder(columns[columnIndex], new Map(columns[columnIndex + 1].map((nodeIndex, position) => [nodeIndex, position])), children);
    }
  }

  const labelLines = nodes.map(node => clipLines(wrapAll(node.label, LABEL_SIZE, INNER_WIDTH), 3, LABEL_SIZE, INNER_WIDTH));
  const detailLines = nodes.map(node => clipLines(wrapAll(node.detail, DETAIL_SIZE, INNER_WIDTH), 2, DETAIL_SIZE, INNER_WIDTH));
  const heights = nodes.map((_, index) => Math.max(
    78,
    13 + 14 + 8 + labelLines[index].length * LABEL_LINE + (detailLines[index].length ? 4 + detailLines[index].length * DETAIL_LINE : 0) + 10,
  ));

  const isBack = (edgeIndex: number) => backEdges.has(edgeIndex) || level[edges[edgeIndex].to] <= level[edges[edgeIndex].from];
  const isSkip = (edgeIndex: number) => !isBack(edgeIndex) && edges[edgeIndex].from !== edges[edgeIndex].to && level[edges[edgeIndex].to] - level[edges[edgeIndex].from] > 1;
  const skipLanes = edges.filter((_, edgeIndex) => isSkip(edgeIndex)).length;
  const backLanes = edges.filter((_, edgeIndex) => isBack(edgeIndex)).length;
  // Direct jumps over one or more columns travel above the node rows, so
  // their line never hides behind a node box; cycles use lanes below.
  const topSpace = skipLanes ? 16 + skipLanes * 26 : 0;

  const columnHeights = columns.map(column => column.reduce((total, nodeIndex) => total + heights[nodeIndex], 0) + Math.max(0, column.length - 1) * GAP_Y);
  const contentHeight = Math.max(...columnHeights, 0);
  const positions = new Array<{ x: number; y: number }>(count);
  columns.forEach((column, columnIndex) => {
    let y = PAD + topSpace + (contentHeight - columnHeights[columnIndex]) / 2;
    const x = PAD + columnIndex * (NODE_WIDTH + GAP_X);
    for (const nodeIndex of column) {
      positions[nodeIndex] = { x, y };
      y += heights[nodeIndex] + GAP_Y;
    }
  });

  const laidNodes: LaidNode[] = nodes.map((node, index) => ({
    index,
    id: node.id,
    label: node.label,
    detail: node.detail,
    kind: node.kind,
    x: positions[index]?.x ?? PAD,
    y: positions[index]?.y ?? PAD,
    height: heights[index],
    labelLines: labelLines[index].length ? labelLines[index] : [''],
    detailLines: detailLines[index],
  }));

  const forwardGroups = new Map<string, number>();
  edges.forEach((edge, edgeIndex) => {
    if (edge.from === edge.to || isBack(edgeIndex) || isSkip(edgeIndex)) return;
    const key = `${edge.from}-${edge.to}`;
    forwardGroups.set(key, (forwardGroups.get(key) ?? 0) + 1);
  });

  const forwardSeen = new Map<string, number>();
  const selfSeen = new Map<number, number>();
  let skipLane = 0;
  let backLane = 0;
  let contentRight = laidNodes.reduce((max, node) => Math.max(max, node.x + NODE_WIDTH), PAD);
  const contentBottom = PAD + topSpace + contentHeight;
  const laidEdges: LaidEdge[] = [];

  edges.forEach((edge, edgeIndex) => {
    const source = laidNodes[edge.from];
    const target = laidNodes[edge.to];
    const base = { key: `${edge.from}-${edge.to}-${edgeIndex}`, from: edge.from, to: edge.to, fullLabel: `${source.label} → ${target.label}${edge.label ? `：${edge.label}` : ''}` };

    if (edge.from === edge.to) {
      const loopIndex = selfSeen.get(edge.from) ?? 0;
      selfSeen.set(edge.from, loopIndex + 1);
      const sx = source.x + NODE_WIDTH;
      const sy = source.y + source.height / 2;
      const offset = loopIndex * 12;
      const label = edge.label ? ellipsize(edge.label, EDGE_LABEL_SIZE, 60) : '';
      const labelX = sx + 34 + offset;
      contentRight = Math.max(contentRight, labelX + measureText(label, EDGE_LABEL_SIZE) / 2);
      laidEdges.push({
        ...base,
        self: true,
        back: false,
        path: `M ${sx} ${sy - 10} C ${sx + 46 + offset} ${sy - 34 - offset} ${sx + 46 + offset} ${sy + 34 + offset} ${sx} ${sy + 12}`,
        label,
        labelX,
        labelY: sy - 22 - offset,
        labelWidth: measureText(label, EDGE_LABEL_SIZE),
      });
      return;
    }

    const label = edge.label ? ellipsize(edge.label, EDGE_LABEL_SIZE, EDGE_LABEL_MAX) : '';
    const labelWidth = measureText(label, EDGE_LABEL_SIZE);

    if (isBack(edgeIndex)) {
      // Out through the right gap, under the columns, back up through the
      // target's left gap. Never crosses a node box.
      const lane = backLane;
      backLane += 1;
      const laneY = contentBottom + 30 + lane * 34;
      const startX = source.x + NODE_WIDTH;
      const startY = source.y + source.height / 2;
      const sourceGapX = startX + 22;
      const targetGapX = Math.max(6, target.x - 22);
      const targetY = target.y + target.height / 2;
      const available = Math.max(EDGE_LABEL_MAX, Math.abs(sourceGapX - targetGapX) - 30);
      const backLabel = edge.label ? ellipsize(edge.label, EDGE_LABEL_SIZE, available) : '';
      const backWidth = measureText(backLabel, EDGE_LABEL_SIZE);
      contentRight = Math.max(contentRight, sourceGapX);
      laidEdges.push({
        ...base,
        self: false,
        back: true,
        path: roundedPath([
          [startX, startY],
          [sourceGapX, startY],
          [sourceGapX, laneY],
          [targetGapX, laneY],
          [targetGapX, targetY],
          [target.x - 5, targetY],
        ], 13),
        label: backLabel,
        labelX: (sourceGapX + targetGapX) / 2,
        labelY: laneY - 9,
        labelWidth: backWidth,
      });
      return;
    }

    if (isSkip(edgeIndex)) {
      const lane = skipLane;
      skipLane += 1;
      const laneY = 3 + (skipLanes - lane) * 26;
      const sourceX = source.x + NODE_WIDTH / 2;
      const targetX = target.x + NODE_WIDTH / 2;
      const available = Math.max(EDGE_LABEL_MAX, Math.abs(targetX - sourceX) - 40);
      const skipLabel = edge.label ? ellipsize(edge.label, EDGE_LABEL_SIZE, available) : '';
      const path = roundedPath([
        [sourceX, source.y - 1],
        [sourceX, laneY],
        [targetX, laneY],
        [targetX, target.y - 4],
      ], 14);
      laidEdges.push({
        ...base,
        self: false,
        back: false,
        path,
        label: skipLabel,
        labelX: (sourceX + targetX) / 2,
        labelY: laneY - 8,
        labelWidth: measureText(skipLabel, EDGE_LABEL_SIZE),
      });
      return;
    }

    const groupKey = `${edge.from}-${edge.to}`;
    const groupSize = forwardGroups.get(groupKey) ?? 1;
    const groupIndex = forwardSeen.get(groupKey) ?? 0;
    forwardSeen.set(groupKey, groupIndex + 1);
    const shift = (groupIndex - (groupSize - 1) / 2) * 30;
    const sx = source.x + NODE_WIDTH + 1;
    const sy = source.y + source.height / 2;
    const tx = target.x - 5;
    const ty = target.y + target.height / 2;
    const dx = Math.max(38, (tx - sx) / 2);
    laidEdges.push({
      ...base,
      self: false,
      back: false,
      path: `M ${sx} ${sy} C ${sx + dx} ${sy + shift} ${tx - dx} ${ty + shift} ${tx} ${ty}`,
      label,
      labelX: (sx + tx) / 2,
      labelY: (sy + ty) / 2 + shift * 0.9 - 9,
      labelWidth,
    });
  });

  const columnsWidth = columns.length ? PAD * 2 + columns.length * NODE_WIDTH + (columns.length - 1) * GAP_X : PAD * 2;
  const width = Math.max(columnsWidth, contentRight + 20);
  const height = backLanes ? contentBottom + 30 + (backLanes - 1) * 34 + 30 : contentBottom + PAD;

  return { width, height, nodes: laidNodes, edges: laidEdges };
}

function GraphCanvas({ graph, title, onExpand }: { graph: GraphData; title: string; onExpand?: () => void }) {
  const layout = useMemo(() => buildLayout(graph), [graph]);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [autoZoom, setAutoZoom] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scroll, setScroll] = useState({ left: 0, max: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const arrowId = `viz-arrow-${uid}`;
  const activeArrowId = `viz-arrow-active-${uid}`;

  useEffect(() => {
    setSelected(null);
    setZoom(1);
    setAutoZoom(true);
  }, [graph]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => {
      setViewportWidth(element.clientWidth);
      setScroll({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', update); };
  }, []);

  // Slightly wider graphs shrink to fit; wide ones keep 100% and scroll inside
  // the graph so text never becomes unreadably small.
  useEffect(() => {
    if (!autoZoom || !viewportWidth) return;
    const ratio = (viewportWidth - 36) / layout.width;
    setZoom(ratio >= AUTO_FIT_MIN && ratio < 1 ? round(ratio, 2) : 1);
  }, [autoZoom, viewportWidth, layout.width]);

  const selectedIndex = selected ? layout.nodes.findIndex(node => node.id === selected) : -1;
  const connectedNodes = new Set<number>();
  const connectedEdges = new Set<string>();
  if (selectedIndex >= 0) {
    connectedNodes.add(selectedIndex);
    layout.edges.forEach(edge => {
      if (edge.from === selectedIndex || edge.to === selectedIndex) {
        connectedEdges.add(edge.key);
        connectedNodes.add(edge.from);
        connectedNodes.add(edge.to);
      }
    });
  }

  if (!layout.nodes.length) return <div className="viz-empty">暂无内容</div>;

  const percent = Math.round(zoom * 100);
  const scaledWidth = Math.max(1, Math.round(layout.width * zoom));
  const scaledHeight = Math.max(1, Math.round(layout.height * zoom));
  const available = Math.max(240, viewportWidth - 36);
  const fit = () => { setAutoZoom(false); setZoom(clamp(round(available / layout.width, 2), MIN_ZOOM, 1.4)); };
  const stepZoom = (delta: number) => { setAutoZoom(false); setZoom(current => clamp(round(current + delta, 1), MIN_ZOOM, MAX_ZOOM)); };
  const selectedNode = selectedIndex >= 0 ? layout.nodes[selectedIndex] : undefined;
  const kinds = [...new Set(layout.nodes.map(node => node.kind))];
  const overflows = scroll.max > 8;
  const scrollBy = (direction: number) => viewportRef.current?.scrollBy({ left: direction * Math.max(180, viewportWidth * 0.7), behavior: 'smooth' });

  const toggleNode = (id: string) => setSelected(current => current === id ? null : id);
  const onNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleNode(id);
    }
  };

  return <div className="viz-graph">
    <div className="viz-graph-toolbar">
      <div className="viz-legend" aria-label="节点类型图例">
        {kinds.map(kind => <span key={kind} className={`viz-legend-item viz-kind-${kind}`}><i aria-hidden="true" />{KIND_META[kind].label}</span>)}
      </div>
      <div className="viz-graph-actions">
        {overflows && <div className="viz-scroll-nav" role="group" aria-label="横向滚动图表">
          <button type="button" className="viz-zoom-button" aria-label="向左滚动图表" title="向左滚动" disabled={scroll.left <= 2} onClick={() => scrollBy(-1)}><ChevronLeft size={14} /></button>
          <button type="button" className="viz-zoom-button" aria-label="向右滚动图表" title="向右滚动" disabled={scroll.left >= scroll.max - 2} onClick={() => scrollBy(1)}><ChevronRight size={14} /></button>
        </div>}
        <div className="viz-zoom" role="group" aria-label="图表缩放">
          <button type="button" className="viz-zoom-button" aria-label="缩小图表" title="缩小" disabled={zoom <= MIN_ZOOM} onClick={() => stepZoom(-ZOOM_STEP)}><Minus size={14} /></button>
          <span className="viz-zoom-value" aria-live="polite" aria-label={`当前缩放 ${percent}%`}>{percent}%</span>
          <button type="button" className="viz-zoom-button" aria-label="放大图表" title="放大" disabled={zoom >= MAX_ZOOM} onClick={() => stepZoom(ZOOM_STEP)}><Plus size={14} /></button>
          <button type="button" className="viz-zoom-fit" onClick={fit} aria-label="适应可用宽度" title="适应可用宽度">适应</button>
          <button type="button" className="viz-zoom-button" aria-label="重置缩放" title="重置缩放" disabled={zoom === 1} onClick={() => { setAutoZoom(false); setZoom(1); }}><RotateCcw size={13} /></button>
        </div>
        {onExpand && <button type="button" className="button small viz-expand" onClick={onExpand}><Maximize2 size={14} />放大</button>}
      </div>
    </div>
    <div className="viz-graph-viewport" ref={viewportRef} tabIndex={0} aria-label={`${title}图表，可横向滚动，并使用缩放按钮查看`}>
      <div className="viz-graph-inner" style={{ width: scaledWidth, height: scaledHeight }}>
        <svg
          className="viz-graph-svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={scaledWidth}
          height={scaledHeight}
          role="group"
          aria-label={`${title}：${layout.nodes.length} 个节点，${layout.edges.length} 条连线`}
        >
          <title>{title}</title>
          <defs>
            <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--viz-edge-arrow)" />
            </marker>
            <marker id={activeArrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--viz-accent)" />
            </marker>
          </defs>
          {layout.edges.map(edge => {
            const active = connectedEdges.has(edge.key);
            const dimmed = Boolean(selected) && !active;
            return <g key={edge.key} className={`viz-edge-group${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}`}>
              <title>{edge.fullLabel}</title>
              <path className="viz-edge" d={edge.path} markerEnd={`url(#${active ? activeArrowId : arrowId})`} />
              {edge.label && <g className="viz-edge-label-group">
                <rect className="viz-edge-pill" x={edge.labelX - edge.labelWidth / 2 - 5} y={edge.labelY - 9.5} width={edge.labelWidth + 10} height={14} rx={4} />
                <text className="viz-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle">{edge.label}</text>
              </g>}
            </g>;
          })}
          {layout.nodes.map(node => {
            const active = connectedNodes.has(node.index);
            const dimmed = Boolean(selected) && !active;
            const isSelected = selectedIndex === node.index;
            const detailTop = 46 + (node.labelLines.length - 1) * LABEL_LINE + 17;
            return <g
              key={node.id}
              className={`viz-node viz-kind-${node.kind}${isSelected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
              transform={`translate(${node.x} ${node.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`${KIND_META[node.kind].label}：${node.label}`}
              onClick={() => toggleNode(node.id)}
              onKeyDown={event => onNodeKeyDown(event, node.id)}
            >
              <title>{`${KIND_META[node.kind].label}：${node.label}`}</title>
              <rect className="viz-node-box" width={NODE_WIDTH} height={node.height} rx={10} />
              <rect className="viz-node-accent" x={0.5} y={13} width={3} height={Math.max(12, node.height - 26)} rx={1.5} />
              <circle className="viz-kind-dot" cx={17} cy={20} r={3.2} />
              <text className="viz-kind-label" x={25} y={23.5}>{KIND_META[node.kind].label}</text>
              <text className="viz-node-label" x={14} y={46}>
                {node.labelLines.map((line, index) => <tspan key={index} x={14} dy={index === 0 ? 0 : LABEL_LINE}>{line || ' '}</tspan>)}
              </text>
              {node.detailLines.length > 0 && <text className="viz-node-detail" x={14} y={detailTop}>
                {node.detailLines.map((line, index) => <tspan key={index} x={14} dy={index === 0 ? 0 : DETAIL_LINE}>{line || ' '}</tspan>)}
              </text>}
            </g>;
          })}
        </svg>
      </div>
    </div>
    <div className="viz-graph-foot" aria-live="polite">
      {selectedNode ? <div className="viz-node-readout">
        <span className={`viz-readout-dot viz-kind-${selectedNode.kind}`} aria-hidden="true" />
        <div>
          <strong>{KIND_META[selectedNode.kind].label} · {selectedNode.label}</strong>
          <p>{selectedNode.detail || '这个节点没有补充说明。'}</p>
        </div>
        <button type="button" className="icon-button viz-readout-close" aria-label="关闭节点说明" onClick={() => setSelected(null)}><X size={14} /></button>
      </div> : <span>{overflows ? '箭头表示流向 · 可左右滚动查看完整图表 · 点击节点查看说明' : layout.edges.length ? '箭头表示流向 · 点击节点查看完整说明' : '没有连线 · 点击节点查看完整说明'}</span>}
    </div>
  </div>;
}

export function VisualizationGraphView({ graph, title }: { graph: GraphData; title: string }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <GraphCanvas graph={graph} title={title} onExpand={() => setExpanded(true)} />
    {expanded && <Modal
      title={`${title} · 放大查看`}
      subtitle="可横向滚动，或使用缩放控制查看细节。"
      wide
      onClose={() => setExpanded(false)}
      footer={<button type="button" className="button" onClick={() => setExpanded(false)}>关闭</button>}
    >
      <div className="viz-graph-modal"><GraphCanvas graph={graph} title={title} /></div>
    </Modal>}
  </>;
}
