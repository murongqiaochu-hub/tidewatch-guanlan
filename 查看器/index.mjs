import * as core from './core.mjs';
const { CONTRACT_SHA, LIMITS, normalizeDirectory, normalizeRevisions, normalizeLayerDoc, viewport, fit, resizeViewport, zoomAt, pan, worldToScreen, screenToWorld, visibleFrames, visibleMetadata, visibleWorld, intersects, corners, hitTest, measurements, spacing, typography, readField, numberText, paintColor, generateCSS, previewLevel, nativeTilePlan, unionBounds, finite } = core;
import { LatestRequest, ResourceScheduler, NativeDownload, decodeDescriptor, imageEstimate, abortError, safeSameOrigin } from './resources.mjs';
const descriptorOf = value => ({ ...value, assetId: value?.assetId ?? value?.id, byteLength: value?.byteLength ?? value?.bytes, filename: value?.originalFileName ?? value?.filename ?? value?.fileName });
const short = value => value == null ? '未知' : String(value);
// Only actual design properties may be rendered as structured values; identity and diagnostics stay in the model.
const designFields = new Set('name description type state value x y width height rotation flipX flipY visible opacity geometry absoluteBoundingBox absoluteTransform relativeTransform polygon cornerRadius rectangleCornerRadii strokeWeight strokeTopWeight strokeRightWeight strokeBottomWeight strokeLeftWeight strokeAlign strokeCap strokeJoin dashPattern clipsContent isMask maskType fills strokes effects color r g b a offset radius spread blendMode blurType gradientStops position gradientHandlePositions imageTransform scaleMode scalingFactor fontName family style fontFamily fontPostScriptName fontSize fontWeight fontStyle lineHeight lineHeightPx lineHeightPercent lineHeightPercentFontSize lineHeightUnit letterSpacing letterSpacingUnit textAlignHorizontal textAlignVertical textCase textDecoration paragraphIndent paragraphSpacing textAutoResize textTruncation maxLines layoutGrids pattern sectionSize gutterSize alignment count offset color constraint format suffix contentsOnly useAbsoluteBounds'.split(' '));
function designProperties(value) {
  if (Array.isArray(value)) return value.map(designProperties);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => designFields.has(key)).map(([key, item]) => [key, designProperties(item)]));
}
const designJSON = value => JSON.stringify(designProperties(value), null, 2);
const stateText = state => !state || state.state === 'missing' ? '未提供' : state.state === 'mixed' ? '混合（无单一值）' : state.state === 'unknown' ? '未知（未解析）' : typeof state.value === 'object' ? designJSON(state.value) : state.value === undefined ? '未知（无可用值）' : String(state.value);
const safeID = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f/\\?#]/.test(value);
const ordered = values => values.map((value, index) => ({ value, index })).sort((a, b) => (finite(a.value.order) ? a.value.order : a.index) - (finite(b.value.order) ? b.value.order : b.index) || a.index - b.index).map(item => item.value);
const PREF_KEY = 'independent-inspector.display.v1';
const preferenceDefaults = { unit: 'px', colorFormat: 'hex', remBase: 16, emBase: 16, density: 1, rounding: 'none', platform: 'web', precision: 4, rpxBase: null, rpxBaseExplicit: false, inspectComponents: true, inspectExports: true, stylesOnly: false, language: 'zh-CN' };
// New local UI vocabulary. Only explicitly bound UI labels are translated, never user design strings.
const EN = Object.freeze({
  '此元素没有切图':'This element has no exports',
  '未命名文件':'Unnamed file','未命名页面':'Unnamed page','操作未完成，请重试。':'Could not complete this action. Please retry.','几何详情':'Geometry details','设计属性（已知值）':'Design properties (known values)','所选文本段属性':'Selected text segment properties','样式信息':'Style information','文件与页面':'Files and pages','代码 / CSS':'Code / CSS','颜色与填充':'Colors and fills','阴影与效果':'Shadows and effects','内阴影':'Inner shadow','外阴影':'Drop shadow','图层模糊':'Layer blur','背景模糊':'Background blur','水平偏移':'Offset X','垂直偏移':'Offset Y','模糊':'Blur','扩展':'Spread','查看此版本全部切图':'View all exports in this revision','实际导出':'Actual export','像素尺寸未提供':'Pixel dimensions not provided','倍率未提供':'Scale not provided','固定宽度':'Fixed width','固定高度':'Fixed height','颜色值':'Color value','隐藏效果':'Hidden effect','透明度未提供':'Opacity not provided',
  '下载此版本全部ZIP':'Download all exports from this revision (ZIP)','下载此历史版本全部ZIP':'Download all exports from this historical revision (ZIP)','整个所查看版本':'Entire viewed revision','所查看版本图层':'Viewed revision layers','所查看版本完整图层树':'Complete viewed revision layer tree','目录为当前发布；画布为所查看版本':'Directory: current publication. Canvas: viewed revision.','所选图层没有原格式切图；可切换整个所查看版本。':'No exports for the selected layer; switch to the entire viewed revision.','所查看版本没有切图。不会混入最新版本。':'The viewed revision has no exports. Latest-revision exports are never substituted.','所查看版本未提供画板名称':'Frame name not provided for the viewed revision','正在加载所查看版本…':'Loading the viewed revision…',
  '尺寸 / 世界BBox':'Dimensions / world BBox','尺寸 / 局部尺寸':'Dimensions / local size','文字样式':'Text style','填充样式':'Fill style','描边样式':'Stroke style','效果样式':'Effect style','网格样式':'Grid style','未知（未解析）':'Unknown (unresolved)','未绑定':'Not assigned','名称未知':'Name unavailable',
  '画板':'Frames','图层':'Layers','目录任务':'Directory tasks','查看任务':'Inspection tasks','页面面板':'Page panels','图层属性':'Layer properties','所选图层切图详情':'Selected layer exports','更多':'More','当前版本':'Current revision','历史版本':'Historical revision','所选版本':'Selected revision','版本未加载':'Revision not loaded','范围仅筛选列表；ZIP始终包含此画板所选版本的全部切图。':'Scope filters this list only. ZIP always contains all exports from the selected frame revision.','宿主未提供有界缩略图；原格式仍可下载。':'Bounded thumbnail unavailable; the original format can still be downloaded.','缩略图不可用':'Thumbnail unavailable',
  '缺失项':'Missing fields','当前版本未提供画板名称':'Frame name not provided for this revision','设置':'Settings','高级':'Advanced','历史':'History','高级 / 图层详情':'Advanced / layer details','高级 / 导出详情':'Advanced / export details','文本选择':'Text selection','预览已加载':'Preview loaded','可见性原值':'Raw visibility',
  '独立设计标注查看器':'Independent design inspector','独立工作台':'Inspection workspace','目录':'Directory','属性':'Inspector','回项目画布':'Back to project canvas','项目导航与面板':'Project navigation and panels','画板与图层目录':'Frames and layers','选中图层属性':'Selected layer properties','画板目录':'Frame directory','当前版本图层':'Revision layers','当前版本完整图层树':'Complete revision layer tree','搜索全部画板目录':'Search all frames','搜索画板名称':'Search frame names','当前缩放':'Zoom level','缩小':'Zoom out','放大':'Zoom in','适应':'Fit','版本与属性':'Revision and properties','当前画板版本':'Frame revision','当前画板历史版本':'Frame revision history','标注':'Inspect','切图':'Exports','单位':'Unit','颜色':'Color','rem基准':'rem base','em基准':'em base','像素密度':'Density','rpx视口宽':'Explicit rpx base','舍入':'Rounding','平台':'Platform','小数位':'Precision','CSS / 已知值':'CSS / known values','复制':'Copy','下载当前版本全部切图 ZIP':'Download revision exports ZIP','取消准备':'Cancel preparation','已检查浏览器下载列表':'I checked browser downloads','切图范围':'Export scope','整个当前版本':'Entire revision','仅所选图层':'Selected layer only','仅查看，不写回设计':'Read only; design is not modified','正在加载':'Loading','重试读取':'Retry loading','取消读取':'Cancel loading','关闭目录':'Close directory','关闭属性':'Close inspector','未选择画板':'No frame selected','打开此文件目录':'Open this file directory','检查范围':'Inspection scope','允许组件内部检查':'Inspect inside components','允许切图内部检查':'Inspect inside export nodes','仅样式元信息':'Style metadata only','语言':'Language','范围策略适用于画布、悬停与目录；不删除图层。':'Scope applies to canvas, hover and tree; no layers are removed.','仅显示样式与组件信息；几何和文本内容暂不展示。':'Only style and component information is shown; geometry and text content are hidden.','原始设计值保留原文，不属于界面翻译。':'Original design values remain in their original language.','世界包围盒':'World bounding box','局部尺寸':'Local size','局部宽':'Local width','局部高':'Local height','世界bounds':'World bounds','尺寸 / 世界坐标':'Dimensions / world coordinates','变换后边长':'Transformed edges','矩阵 2×3':'Matrix 2×3','类型':'Type','平台节点':'Figma node ID','命中精度':'Hit precision','可见性':'Visibility','透明度':'Opacity','外观':'Appearance','圆角':'Corner radius','四角':'Corner radii','描边宽':'Stroke width','分边描边':'Per-side strokes','描边对齐':'Stroke alignment','裁剪 / 遮罩':'Clip / mask','填充':'Fills','描边':'Strokes','效果':'Effects','状态':'State','文本 / 字体':'Text / typography','文本':'Text','所选真实段 raw':'Selected run raw','区间':'Range','样式':'Style','组件 / 样式引用':'Component / style references','组件':'Component','祖先上下文':'Ancestor context','组件详情':'Component details','名称':'Name','描述':'Description','身份':'Identity','分类样式目录 / 实际值':'Style categories / actual values','所选节点原始字段（含未知值）':'Selected node raw (including unknown values)','选择真实文本段':'Select actual text run','全文（保留混合状态）':'Whole text (mixed state retained)','复制所选段':'Copy selected run','复制全文':'Copy whole text',
  '复制完整文本':'Copy complete text','下载原格式':'Download original format','导出设置':'Export settings','正在读取完整画板目录…':'Loading complete frame directory…','正在加载完整目录…':'Loading complete directory…','正在加载选中版本…':'Loading selected revision…','正在加载当前版本…':'Loading current revision…','正在读取选中版本图层…':'Loading selected revision layers…','选择画板后读取一份版本树':'Select a frame to load one revision tree','暂无画板，请在宿主提供已授权的设计数据。':'No frames. Supply authorized design data through the host.','本文件暂无画板。':'This file has no frames.','没有匹配的画板；目录未被截断。':'No matching frames; the directory is not truncated.','加载失败':'Loading failed','原生细节（≥1:1，仅可见区）':'Native detail (≥1:1, visible area only)','等待可见区预览请求；未声称已解码':'Waiting for a visible-area preview request; not decoded yet','原格式下载，暂不提供栅格预览。':'Download the original format; raster preview is unavailable.','已实际解码预览；原格式下载未重编码':'Preview decoded; original download is not re-encoded','当前画板的当前版本没有切图。不会混入最新版本。':'This frame revision has no exports. Latest-revision exports are not substituted.','所选图层没有原格式切图；可切换整个当前版本。':'No exports for the selected layer; switch to the entire revision.','点击图层查看尺寸、样式和文本。Shift点击另一图层测量间距。':'Select a layer to inspect dimensions, styles and text. Shift-select another layer to measure.','拖动平移 · 滚轮缩放 · 选中后悬停测距 · Ctrl/Cmd 根百分比 · Alt 祖先百分比':'Drag to pan · Wheel to zoom · Hover after selection to measure · Ctrl/Cmd root % · Alt ancestor %','可缩放设计画布；方向键平移，加减缩放，F适应，1原尺寸，回车选择中心图层':'Design canvas; arrows pan, +/- zoom, 0/F fit, 1 actual size, Enter selects the center layer',
});
const errorText = error => error?.message || '发生未知错误';
const nodePrecision = node => node.precision === 'bounds' || [...node.clips, ...node.masks].some(n => n.precision === 'bounds') ? 'bounds' : 'geometry';
// Chrome annotations only. Raw design bitmaps and design paint values never pass through this palette.
const canvasChrome = Object.freeze({ panel: '#112b32', line: '#20464d', text: '#88a7a3', selection: '#8fd9c4', ink: '#0f262b', measurement: '#f0a7af' });
const icons = {
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  inspect: '<rect x="4" y="4" width="12" height="12" rx="1"/><path d="m14 14 6 6M8 8h4M10 6v4"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="8" y="8" width="8" height="8"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  frame: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 2v4M2 8h4m12 8h4m-6 2v4"/>',
  layer: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5m-18 5 9 5 9-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m14 5-7 7 7 7M7 12h14"/>',
  more: '<path d="M5 11v2m7-2v2m7-2v2"/>',
  settings: '<path d="M9 4h6l1 3 3 1 1 5-2 2-1 4-5 1-3-2-4-1-1-5 2-3 1-4 2-1Z"/><path d="M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z"/>',
};
function icon(name, document) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('ii-icon');
  // Only fixed local geometric primitives; no HTML parser or upstream markup.
  for (const match of (icons[name] ?? icons.layer).matchAll(/<(path|rect)\s+([^>]*?)\/>/g)) {
    const primitive = document.createElementNS('http://www.w3.org/2000/svg', match[1]);
    for (const attr of match[2].matchAll(/([a-z]+)="([^"]*)"/g)) primitive.setAttribute(attr[1], attr[2]);
    svg.append(primitive);
  }
  return svg;
}
export function mountInspector(container, { adapter, initialFrameId = null, initialRevisionId = null } = {}) {
  if (!container?.ownerDocument || !adapter || !['listFrames', 'listRevisions', 'loadRevision'].every(k => typeof adapter[k] === 'function')) throw new TypeError('需要DOM容器和有效adapter');
  const document = container.ownerDocument, window = document.defaultView, baseURL = document.baseURI;
  let preferences = { ...preferenceDefaults };
  try { const stored = JSON.parse(window.localStorage?.getItem(PREF_KEY) ?? 'null'); if (stored && typeof stored === 'object') for (const key of Object.keys(preferenceDefaults)) if (Object.hasOwn(stored,key)) preferences[key] = stored[key]; } catch { /* storage is optional */ }
  preferences = validPreferences(preferences);
  const tr = key => preferences.language === 'en' ? EN[key] ?? key : key, bindings = new Map();
  const el = (tag, className = '', text = '') => { const n = document.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; };
  const bindUI = (node,key,attribute = null) => { const values = bindings.get(node) ?? new Map(); values.set(attribute,key); bindings.set(node,values); if(attribute) node.setAttribute(attribute,tr(key)); else node.textContent=tr(key); return node; };
  const ui = (tag,className,key) => bindUI(el(tag,className),key);
  const labelUI = (className,key) => { const node=el('label',className);node.append(ui('span','',key));return node; };
  const button = (text, name, action, className = '') => { const n = el('button', `ii-button ${className}`); n.type = 'button'; if (name) n.append(icon(name, document)); if (text) n.append(ui('span', '', text)); if(text) bindUI(n,text,'aria-label'); else n.setAttribute('aria-label',''); if (action) n.addEventListener('click', action); return n; };
  const root = el('section', 'ii-root'); bindUI(root,'独立设计标注查看器','aria-label');
  const stylesheet = el('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./inspector.css', import.meta.url).href; root.append(stylesheet);
  const disclosure = (className, title) => { const node = el('details', className); node.open = false; node.append(ui('summary', '', title)); return node; };
  const header = el('header', 'ii-header'), brand = el('div', 'ii-brand');
  const leftToggle = button('目录', 'panels', () => togglePanel('directory')), rightToggle = button('属性', 'inspect', () => togglePanel('inspector'));
  const projectContext = el('span', 'ii-project-context'), breadcrumb = el('div', 'ii-breadcrumb'), contextTitle = el('strong', 'ii-context-title');
  const canvasLink = el('a', 'ii-button ii-icon-only ii-back-link'), libraryLink = el('a','ii-button ii-library-link');
  bindUI(canvasLink,'回项目画布','aria-label'); bindUI(canvasLink,'回项目画布','title'); canvasLink.append(icon('back',document),ui('span','','回项目画布'));
  bindUI(libraryLink,'切图','aria-label'); bindUI(libraryLink,'切图','title'); libraryLink.append(ui('span','','切图'));
  canvasLink.hidden = libraryLink.hidden = true; canvasLink.rel = libraryLink.rel = 'noopener';
  const headerActions = el('nav', 'ii-header-actions'); bindUI(headerActions,'项目导航与面板','aria-label');
  const mobileTasks = el('nav','ii-mobile-tasks'); bindUI(mobileTasks,'页面面板','aria-label');
  breadcrumb.append(projectContext,contextTitle); brand.append(canvasLink,breadcrumb); header.append(brand,headerActions);
  const body = el('div', 'ii-body'), sidebar = el('aside', 'ii-sidebar'), main = el('main', 'ii-main'), panel = el('aside', 'ii-inspector');
  bindUI(sidebar,'画板与图层目录','aria-label'); bindUI(panel,'选中图层属性','aria-label');
  const dirTitle = el('div', 'ii-section-heading'); dirTitle.append(ui('h2', '', '画板分组')); const countLabel = el('span', 'ii-muted', '0'); dirTitle.append(countLabel);
  const directoryTabs = el('div','ii-directory-tabs'); bindUI(directoryTabs,'目录任务','aria-label');
  const framesTask = button('画板','frame',() => setDirectoryTab('frames')), layersTask = button('图层','layer',() => setDirectoryTab('layers')); directoryTabs.append(framesTask,layersTask);
  const framesPage = el('div','ii-directory-page'), layersPage = el('div','ii-directory-page');
  const searchLabel = el('label', 'ii-search'), search = el('input'); search.type = 'search'; bindUI(search,'搜索画板名称','placeholder'); bindUI(search,'搜索全部画板目录','aria-label'); searchLabel.append(search);
  const frameList = el('div', 'ii-frame-list'); frameList.setAttribute('role', 'list');
  const treeTitle = el('div', 'ii-section-heading ii-tree-heading'); treeTitle.append(ui('h2', '', '所查看版本图层')); const treeCount = el('span', 'ii-muted', '—'); treeTitle.append(treeCount);
  const treeContext = el('p','ii-tree-context');
  const tree = el('div', 'ii-tree'); tree.setAttribute('role', 'tree'); bindUI(tree,'所查看版本完整图层树','aria-label');
  framesPage.append(searchLabel,ui('p','ii-directory-note','目录为当前发布；画布为所查看版本'),frameList); layersPage.append(treeTitle,treeContext,tree); sidebar.append(dirTitle,directoryTabs,framesPage,layersPage);
  const toolbar = el('div', 'ii-toolbar');
  const zoomTools = el('div', 'ii-zoom-tools'), zoomLabel = el('output', 'ii-zoom-value', '100%'); bindUI(zoomLabel,'当前缩放','aria-label');
  const minus = button('缩小', 'minus', () => changeZoom(0.8), 'ii-icon-only'), plus = button('放大', 'plus', () => changeZoom(1.25), 'ii-icon-only');
  zoomTools.append(minus, zoomLabel, plus, button('适应', 'fit', () => fitView()), button('1:1', null, () => fitView(1)));
  const stage = el('div', 'ii-stage'), canvas = el('canvas', 'ii-canvas'); canvas.tabIndex = 0; canvas.setAttribute('role', 'img'); bindUI(canvas,'可缩放设计画布；方向键平移，加减缩放，F适应，1原尺寸，回车选择中心图层','aria-label');
  const stageMessage = el('div', 'ii-stage-message'), stageMessageText = ui('p','','正在读取完整画板目录…'); stageMessage.setAttribute('role', 'status'); stageMessage.append(stageMessageText);
  const stageHint = ui('div', 'ii-stage-hint', '拖动平移 · 滚轮缩放 · 选中后悬停测距 · Ctrl/Cmd 根百分比 · Alt 祖先百分比');
  const measurementStatus = el('output', 'ii-measurement-status'); measurementStatus.setAttribute('aria-live', 'polite'); measurementStatus.hidden = true;
  const stageFooter = el('div', 'ii-stage-footer ii-sr-only'), location = ui('span', 'ii-muted', '未选择画板'); stageFooter.append(location);
  const stageAdvanced = disclosure('ii-stage-advanced', '高级'), stageAdvancedBody = el('div','ii-stage-options');
  const nativeLabel = el('label', 'ii-checkbox'), nativeInput = el('input'); nativeInput.type = 'checkbox'; nativeInput.checked = true; nativeLabel.append(nativeInput, ui('span', '', '原生细节（≥1:1，仅可见区）')); stageAdvancedBody.append(stageHint,nativeLabel); stageAdvanced.append(stageAdvancedBody);
  toolbar.append(zoomTools,stageAdvanced); stage.append(canvas,stageMessage,measurementStatus,stageFooter,toolbar); main.append(stage);
  const revisionHeading = el('div', 'ii-section-heading ii-inspector-heading'), panelTitle = ui('h2', '', '图层属性'); revisionHeading.append(panelTitle);
  const revisionLabel = el('label', 'ii-field-label ii-history'), revisionSelect = el('select'), revisionState = el('span','ii-revision-state'); bindUI(revisionSelect,'当前画板历史版本','aria-label'); revisionSelect.title='切换历史版本'; revisionLabel.append(revisionSelect,revisionState); headerActions.append(ui('span','ii-history-caption','版本'),revisionLabel,leftToggle,rightToggle,libraryLink);
  const identityBox = el('div', 'ii-identity'), properties = el('div', 'ii-properties');
  const details = el('div', 'ii-details'), slices = el('div', 'ii-slices');
  const cssSettings = el('div', 'ii-css-settings'), unitLabel = labelUI('', '单位'), unitSelect = el('select'), colorLabel = labelUI('', '颜色'), colorSelect = el('select'), remLabel = labelUI('', 'rem基准'), remInput = el('input');
  for (const value of ['px', 'rem', 'em', 'pt', 'dp', 'rpx']) { const option = el('option', '', value); option.value = value; unitSelect.append(option); }
  for (const value of ['hex', 'hexa', 'rgba', 'hsla']) { const option = el('option', '', value); option.value = value; colorSelect.append(option); }
  const settings = el('details','ii-settings'), settingsSummary = el('summary'), settingsContent = el('div','ii-settings-content'), settingsBody = el('div', 'ii-settings-body'); settings.open = false; settingsSummary.append(icon('settings',document),ui('span','','设置')); bindUI(settingsSummary,'设置','title'); settings.append(settingsSummary,settingsContent);
  remInput.type = 'number'; remInput.min = '1'; remInput.step = '0.25'; remInput.value = '16'; unitLabel.append(unitSelect); colorLabel.append(colorSelect); remLabel.append(remInput); cssSettings.append(unitLabel, colorLabel); settingsBody.append(remLabel);
  const preferenceInputs = { unit: unitSelect, colorFormat: colorSelect, remBase: remInput };
  for (const [key, label, values] of [['emBase', 'em基准', null], ['density', '像素密度', null], ['rpxBase', 'rpx视口宽', null], ['rounding', '舍入', ['none', 'round', 'ceil', 'floor']], ['platform', '平台', ['web', 'ios', 'android']], ['precision', '小数位', null]]) {
    const field = labelUI('', label), input = el(values ? 'select' : 'input');
    if (values) for (const value of values) { const option = el('option', '', value); option.value = value; input.append(option); }
    else { input.type = 'number'; input.min = key === 'precision' ? '0' : '0.01'; input.max = key === 'precision' ? '8' : '10000'; input.step = key === 'precision' ? '1' : '0.25'; }
    bindUI(input,label,'aria-label'); if (key === 'rpxBase') { input.title = 'Explicit viewport basis in px; not inferred from local geometry'; input.placeholder = 'px'; } preferenceInputs[key] = input; field.append(input); settingsBody.append(field);
  }
  function validPreferences(input) {
    const value = { ...preferenceDefaults, ...input };
    for (const [key, allowed] of [['unit', ['px','rem','em','pt','dp','rpx']], ['colorFormat', ['hex','hexa','rgba','hsla']], ['rounding', ['none','round','ceil','floor']], ['platform', ['web','ios','android']]]) if (!allowed.includes(value[key])) value[key] = preferenceDefaults[key];
    for (const key of ['remBase','emBase','density']) if (!(Number.isFinite(Number(value[key])) && Number(value[key]) > 0 && Number(value[key]) <= 10000)) value[key] = preferenceDefaults[key]; else value[key] = Number(value[key]);
    for (const key of ['inspectComponents','inspectExports','stylesOnly']) if (typeof value[key] !== 'boolean') value[key] = preferenceDefaults[key];
    if (!['zh-CN','en'].includes(value.language)) value.language = 'zh-CN';
    value.rpxBaseExplicit = value.rpxBaseExplicit === true; value.rpxBase = value.rpxBaseExplicit && value.rpxBase != null && String(value.rpxBase).trim() && finite(Number(value.rpxBase)) && Number(value.rpxBase) > 0 && Number(value.rpxBase) <= 10000000 ? Number(value.rpxBase) : null;
    value.precision = Number.isInteger(Number(value.precision)) && Number(value.precision) >= 0 && Number(value.precision) <= 8 ? Number(value.precision) : 4; return value;
  }
  const inspectionSettings = el('fieldset','ii-inspection-settings'); inspectionSettings.append(ui('legend','','检查范围'));
  for (const [key,title] of [['inspectComponents','允许组件内部检查'],['inspectExports','允许切图内部检查'],['stylesOnly','仅样式元信息']]) {
    const field = el('label','ii-checkbox'), input = el('input'); input.type='checkbox'; bindUI(input,title,'aria-label'); field.append(input,ui('span','',title)); preferenceInputs[key]=input; inspectionSettings.append(field);
  }
  const languageField = labelUI('ii-language-field','语言'), languageInput=el('select'); bindUI(languageInput,'语言','aria-label');
  for(const [value,text] of [['zh-CN','简体中文'],['en','English']]) {const option=el('option','',text);option.value=value;languageInput.append(option);} preferenceInputs.language=languageInput; languageField.append(languageInput); inspectionSettings.append(languageField,ui('p','ii-note','范围策略适用于画布、悬停与目录；不删除图层。'),ui('p','ii-note','原始设计值保留原文，不属于界面翻译。'));
  for (const [key,input] of Object.entries(preferenceInputs)) if(input.type==='checkbox') input.checked=preferences[key]; else input.value=preferences[key]==null?'':String(preferences[key]);
  // The published design spec decides the default annotation unit: Web px, iOS pt, Android dp.
  // The multiplier converts design pixels to that logical unit; user changes stay until the spec changes.
  function applyDesignPreferences(snapshot) {
    const design = snapshot?.design;
    if (!design || !['web','ios','android'].includes(design.spec)) return;
    const scale = Number(design.scale), signature = `${design.spec}:${Number.isFinite(scale) && scale > 0 ? scale : 1}`;
    if (signature === state.designSignature) return;
    state.designSignature = signature;
    const unit = design.spec === 'web' ? 'px' : design.spec === 'ios' ? 'pt' : 'dp';
    preferences = validPreferences({ ...preferences, unit, platform: design.spec, density: Number.isFinite(scale) && scale > 0 ? scale : 1 });
    for (const [key, input] of Object.entries(preferenceInputs)) if (input.type === 'checkbox') input.checked = preferences[key]; else input.value = preferences[key] == null ? '' : String(preferences[key]);
    try { window.localStorage?.setItem(PREF_KEY, JSON.stringify(preferences)); } catch { /* Storage is optional. */ }
  }
  function displayLength(value) { return typeof core.displayValue === 'function' ? core.displayValue(value, preferences).text : value == null ? '未提供' : `${numberText(value)}px`; }
  const cssTitle = el('div', 'ii-section-heading'); cssTitle.append(ui('h3', '', 'CSS / 已知值')); const copyButton = button('复制', null, () => copyCSS()); cssTitle.append(copyButton);
  const cssOutput = el('pre', 'ii-code'), cssWarnings = el('div', 'ii-note');
  settingsContent.append(cssSettings,settingsBody,inspectionSettings); revisionHeading.append(settings);
  const cssDisclosure = disclosure('ii-css-disclosure','代码 / CSS'); cssDisclosure.open = true; cssDisclosure.append(cssTitle,cssOutput,cssWarnings); details.append(cssDisclosure);
  const zipButton = button('下载此版本全部ZIP', 'download', () => startDownload('zip'), 'ii-full-width');
  const cancelDownload = button('取消准备', 'close', () => download.cancel()), checkedDownload = button('已检查浏览器下载列表', null, () => download.acknowledgeBrowserChecked());
  const sliceScopeLabel = labelUI('ii-field-label', '切图范围'), sliceScope = el('select'); bindUI(sliceScope,'切图范围','aria-label');
  for (const [value, label] of [['node','仅所选图层'],['frame','整个所查看版本']]) { const option = el('option', '', label); option.value = value; sliceScope.append(option); } sliceScope.value='node'; sliceScopeLabel.append(sliceScope);
  const scopeNote = ui('p','ii-note ii-scope-note','范围仅筛选列表；ZIP始终包含此画板所选版本的全部切图。'), sliceCount = el('p','ii-slice-count');
  const downloadStatus = el('p', 'ii-note'), sliceList = el('div', 'ii-slice-list');
  const showAllSlices = button('查看此版本全部切图', null, () => { sliceScope.value='frame'; setPropertyTab('slices'); renderSlices(); requestRender(true); }, 'ii-view-all-exports');
  slices.append(sliceScopeLabel,sliceCount,sliceList,zipButton,scopeNote,downloadStatus,cancelDownload,checkedDownload);
  // The same inspector adapts to selected-layer data; no separate Inspect/Exports tabs.
  panel.append(revisionHeading,properties,details,slices,identityBox);
  body.append(sidebar, main, panel);
  const status = el('footer', 'ii-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const help = ui('span', '', '仅查看，不写回设计'), activity = ui('span', 'ii-muted', '正在加载');
  const retryLoadButton = button('重试读取',null,() => retryLoad()), cancelLoadButton = button('取消读取',null,() => { loadRequest.cancel(); directoryRequest.cancel(); loadFailed(abortError('已取消读取；不会采用迟到响应')); }); retryLoadButton.hidden = true;
  const loadActions = el('div','ii-load-actions'); loadActions.append(retryLoadButton,cancelLoadButton); stageMessage.append(loadActions); status.append(help,activity);
  root.append(header,body,status,mobileTasks); container.append(root);
  const scheduler = new ResourceScheduler(), loadRequest = new LatestRequest(), directoryRequest = new LatestRequest(), locationRequest = new LatestRequest();
  const state = { frames: [], revisions: [], frameId: null, revisionId: null, snapshot: null, doc: null, selected: null, reference: null, hovered: null, mode: 'frame', context: adapter.context ?? {}, selectedRun: null, modifiers: { root: false, ancestor: false }, navigation: null, propertyTab: 'details', directoryTab: 'frames', v: viewport(), loading: true, error: null, disposed: false, renderedFrames: [], paintFrames: [], paintedImageFrames: 0, imageDrawCalls: 0, hoveredFrameId: null, imagePlans: new Map(), imageErrors: new Map(), lastImageSignature: '', imageGeneration: 0, fitPending: true, activePanel: null, lastPrecision: null, designSignature: null, groups: [] };
  let raf = 0, needsImageRefresh = false, resizeObserver = null, imageRetry = false;
  const sliceTargets = new Map(), directoryTargets = new Map(), lowCache = new Map();
  function clearDirectoryThumbnails() {
    for (const [key, plan] of state.imagePlans) if (plan.kind === 'directory-preview') { scheduler.cancel(key); state.imagePlans.delete(key); state.imageErrors.delete(key); }
    for (const target of directoryTargets.values()) { target.canvas.width = 0; target.canvas.height = 0; }
    directoryTargets.clear(); state.lastImageSignature = '';
  }
  function directoryTargetVisible(target) {
    if (state.directoryTab !== 'frames' || state.directoryCollapsed || panelIsNarrow() && state.activePanel !== 'directory') return false;
    for (let node = target.canvas; node && node !== root; node = node.parentNode) if (node.hidden || node.tagName === 'DETAILS' && !node.open) return false;
    const box = target.canvas.getBoundingClientRect(), clip = frameList.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && clip.width > 0 && clip.height > 0 && box.bottom > clip.top && box.top < clip.bottom && box.right > clip.left && box.left < clip.right;
  }
  const collapsedGroups = new Set(); let directoryGroupsInitialized = false, lastDirectoryFrameId = null, focusBeforePanel = null;
  const closeDirectory = button('关闭目录', 'close', () => togglePanel(null), 'ii-panel-close'), closeInspector = button('关闭属性', 'close', () => togglePanel(null), 'ii-panel-close'); dirTitle.append(closeDirectory); revisionHeading.append(closeInspector,settings);
  const download = new NativeDownload({
    baseURL,
    getDescriptor: async request => {
      if (typeof adapter.getSliceDownloadUrl !== 'function') throw new Error('宿主尚未提供原格式授权下载接口');
      const result = await adapter.getSliceDownloadUrl(request.frameId, request.revisionId, { kind: request.kind, sliceId: request.sliceId, signal: request.signal });
      return typeof result === 'string' ? { url: result } : descriptorOf(result);
    },
    handoff: descriptor => {
      const anchor = el('a'); anchor.href = descriptor.url; anchor.download = descriptor.filename; anchor.rel = 'noopener'; anchor.hidden = true;
      root.append(anchor); try { anchor.click(); } finally { anchor.remove(); }
    },
    onChange: value => renderDownload(value),
  });
  const ctx = canvas.getContext('2d');
  if (!ctx) { root.remove(); throw new Error('当前浏览器未提供Canvas 2D'); }
  function safeNavigationURL(value) {
    const url = new URL(safeSameOrigin(value, baseURL));
    if (!/^\/viewer\/(?:p|r)\/[^/]+(?:\/slices)?\/?$/.test(url.pathname)) throw new TypeError('导航仅允许同源Viewer项目/画板白名单路径'); return url;
  }
  function refreshContext() {
    const context = state.context ?? {}; contextTitle.textContent = state.frameId ? selectedRevisionName() : context.projectName ?? tr('未选择画板'); const contextPath = [context.projectName, context.designFileName ?? currentFrame()?.designFileName].filter(Boolean).join(' / '); contextTitle.title = panelIsNarrow() ? contextTitle.textContent : contextPath;
    projectContext.textContent = context.projectName ?? ''; projectContext.hidden = !context.projectName; projectContext.title = context.projectName ?? ''; breadcrumb.title = [contextPath,contextTitle.textContent].filter(Boolean).join(' / ');
    for (const [link, path, frameQuery] of [[canvasLink, context.projectCanvasUrl, 'frame'], [libraryLink, context.projectSlicesUrl, 'frameId']]) {
      link.hidden = true; if (!path) continue;
      try {
        const url = safeNavigationURL(path);
        if (link === libraryLink) {
          const frame = currentFrame(), projectId = state.doc?.identity.projectId ?? frame?.projectId ?? context.projectId;
          if (!frame || !safeID(state.frameId) || !/^[-\w]+$/.test(state.frameId)) continue;
          if (!/^\/viewer\/p\/[^/]+\/slices\/?$/.test(url.pathname) || projectId != null && url.pathname.replace(/\/$/, '') !== `/viewer/p/${encodeURIComponent(projectId)}/slices`) throw new TypeError('切图导航不属于当前项目');
          // The library shows project-current revisions, not the historical revision being inspected.
          url.search = ''; url.hash = '';
        }
        if (state.frameId) url.searchParams.set(frameQuery, state.frameId); link.href = url.href; link.hidden = false;
      } catch { link.title = '宿主导航URL不在安全白名单内'; }
    }
    root.dataset.permissions = context.permissions ? 'provided' : 'unknown';
  }
  async function commitLocation({ replace = false, fromLocation = false } = {}) {
    refreshContext(); if (fromLocation || !state.doc) return;
    const identity = state.doc.identity, target = { frameId: identity.frameId, revisionId: identity.revisionId, mode: state.mode, designFileId: identity.designFileId, pageId: identity.pageId, replace };
    state.navigation = target;
    try {
      if (typeof adapter.onNavigate === 'function') await adapter.onNavigate(target);
      else if (window.history && window.location) { const url = safeNavigationURL(`/viewer/r/${encodeURIComponent(identity.frameId)}`); url.searchParams.set('revision', identity.revisionId); if (state.mode === 'project') url.searchParams.set('mode', 'project'); window.history[replace ? 'replaceState' : 'pushState']({ independentInspector: target }, '', url.href); }
    } catch (error) { say(`已载入；URL同步失败：${errorText(error)}`, true); }
  }
  function panelIsNarrow() { return typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 900px)').matches : (root.getBoundingClientRect().width <= 900); }
  let compactControls = null, compactDockControls = null;
  function syncPanelSemantics() {
    const narrow = panelIsNarrow(), modal = narrow && !!state.activePanel, active = state.activePanel === 'directory' ? sidebar : panel;
    // Move the same task controls at the breakpoint; never duplicate trees, listeners, or tasks.
    if (compactControls !== narrow) {
      compactControls = narrow;
      if (narrow) mobileTasks.append(leftToggle,rightToggle);
      else headerActions.append(leftToggle,rightToggle,libraryLink);
    }
    const compactDock = narrow || root.getBoundingClientRect().width < 1360;
    if (compactDockControls !== compactDock || toolbar.parentNode !== (narrow ? stage : header)) {
      compactDockControls = compactDock;
      // Move the original controls, never clone listeners/zoom state or add a second desktop bar.
      if (narrow) stage.append(toolbar); else header.append(toolbar,headerActions);
      toolbar.replaceChildren(zoomTools,stageAdvanced);
    }
    for (const side of [sidebar, panel]) { const open = modal && side === active; side.setAttribute('role', open ? 'dialog' : 'complementary'); side.setAttribute('aria-modal', String(open)); side.inert = narrow ? !open : side === sidebar ? !!state.directoryCollapsed : !!state.inspectorCollapsed; }
    main.inert = modal; header.inert = modal; status.inert = modal; mobileTasks.inert = modal; canvasLink.inert = libraryLink.inert = modal; brand.inert = modal;
    leftToggle.setAttribute('aria-expanded', String(narrow ? state.activePanel === 'directory' : !state.directoryCollapsed)); rightToggle.setAttribute('aria-expanded', String(narrow ? state.activePanel === 'inspector' : !state.inspectorCollapsed));
  }
  function togglePanel(value) {
    if (!panelIsNarrow() && value) { const key = value === 'directory' ? 'directoryCollapsed' : 'inspectorCollapsed'; state[key] = !state[key]; root.dataset[key] = String(state[key]); syncPanelSemantics(); requestRender(true); return; }
    const was = state.activePanel; state.activePanel = !value || state.activePanel === value ? null : value; root.dataset.panel = state.activePanel ?? ''; syncPanelSemantics();
    if (state.activePanel && panelIsNarrow()) { if (!was) focusBeforePanel = document.activeElement; (state.activePanel === 'directory' ? closeDirectory : closeInspector).focus(); }
    else if (was) { (focusBeforePanel ?? (was === 'directory' ? leftToggle : rightToggle)).focus?.(); focusBeforePanel = null; }
    requestRender(true);
  }
  function setDirectoryTab(value) { state.directoryTab = value; framesPage.hidden = value !== 'frames'; layersPage.hidden = value !== 'layers'; framesTask.setAttribute('aria-pressed',String(value === 'frames')); layersTask.setAttribute('aria-pressed',String(value === 'layers')); requestRender(true); }
  function setPropertyTab(value) { state.propertyTab = value; root.dataset.task = value; details.hidden = value !== 'details'; slices.hidden = value !== 'slices'; bindUI(panelTitle,value === 'details' ? '样式信息' : '实际导出'); bindUI(panel,value === 'details' ? '选中图层属性' : '所选图层切图详情','aria-label'); syncPanelSemantics(); requestRender(true); }
  function revealInspector() {
    if (panelIsNarrow()) { if (state.activePanel !== 'inspector') togglePanel('inspector'); }
    else if (state.inspectorCollapsed) togglePanel('inspector');
  }
  const displayError = message => {
    const status = String(message ?? '').match(/\bHTTP\s+(401|403|404)\b/i)?.[1];
    if (status) return preferences.language === 'en' ? `Design unavailable (HTTP ${status}). Check access and retry.` : `设计暂不可用（HTTP ${status}），请检查访问权限后重试。`;
    return tr('操作未完成，请重试。');
  };
  function say(message, isError = false) { activity.textContent = isError ? displayError(message) : message; activity.title = activity.textContent; status.dataset.error = String(isError); }
  function refreshControls() {
    zoomLabel.textContent = `${numberText(state.v.scale * 100, 1)}%`;
    location.textContent = selectedRevisionName();
    contextTitle.textContent = state.frameId ? selectedRevisionName() : state.context?.projectName ?? tr('未选择画板');
    const pathTitle = [state.context?.projectName,state.context?.designFileName ?? currentFrame()?.designFileName].filter(Boolean).join(' / '); contextTitle.title = panelIsNarrow() ? contextTitle.textContent : pathTitle;
    breadcrumb.title = [pathTitle,contextTitle.textContent].filter(Boolean).join(' / '); treeContext.textContent = selectedRevisionName(); treeContext.title = selectedRevisionName();
    const revisionKind = revisionStatus(); revisionState.textContent = tr(revisionKind); revisionState.dataset.history = String(revisionKind === '历史版本');
    const revision = state.revisions.find(value => value.revisionId === state.revisionId); revisionSelect.title = revision ? revisionDisplay(revision, state.revisions.indexOf(revision)) : tr(revisionKind);
    header.dataset.history = String(revisionKind === '历史版本');
    const zipLabel = revisionKind === '历史版本' ? '下载此历史版本全部ZIP' : '下载此版本全部ZIP'; bindUI(zipButton,zipLabel,'aria-label'); bindUI(zipButton.children[1],zipLabel);
    canvas.setAttribute('aria-label', `${selectedRevisionName()} · ${tr('可缩放设计画布；方向键平移，加减缩放，F适应，1原尺寸，回车选择中心图层')}`);
    retryLoadButton.hidden = !state.error; cancelLoadButton.hidden = !state.loading;
    revisionSelect.disabled = state.loading || !state.revisions.length;
    zipButton.disabled = state.loading || !state.snapshot || !currentSlices().length || ['preparing', 'checking', 'cancelling', 'notSavedYet', 'unknown'].includes(download.state);
    nativeInput.disabled = !adapter.getNativeTile || currentAsset()?.mime !== 'image/png';
    nativeLabel.title = !adapter.getNativeTile ? '宿主未提供原生图块；使用有界LOD预览' : currentAsset()?.mime !== 'image/png' ? '自动原生细节当前仅适用于PNG原资源' : '默认在缩放达到1:1时加载可见512图块；可关闭，选择跨版本保持';
  }
  function currentFrame() { return state.frames.find(frame => frame.frameId === state.frameId); }
  function currentRevisionIdentity() { const frame = currentFrame(); return frame?.currentRevisionId ?? state.revisions.find(value => value.current)?.revisionId ?? frame?.latestRevisionId ?? (frame?.revisionId !== 'current' ? frame?.revisionId : null); }
  function revisionStatus(revisionId = state.revisionId) { if (!revisionId) return '版本未加载'; const current = currentRevisionIdentity(); return current ? String(current) === String(revisionId) ? '当前版本' : '历史版本' : '所选版本'; }
  // Directory entries describe current navigation, not the selected historical snapshot.
  function selectedRevisionName() {
    if (!state.frameId) return tr('未选择画板');
    if (!state.doc) return tr(state.loading ? '正在加载选中版本…' : '所查看版本未提供画板名称');
    const name = state.doc.frame.raw?.name;
    return typeof name === 'string' && name.trim() ? state.doc.frame.name : tr('所查看版本未提供画板名称');
  }
  function currentAsset() { const snapshot = state.snapshot; if (!snapshot) return null; const raw = snapshot.previewAsset ?? snapshot.assets?.find(a => a.role === 'frame' || a.role === 'preview') ?? snapshot.assets?.[0]; return raw ? descriptorOf(raw) : null; }
  function currentSlices() { if (state.snapshot?.noExports === true) return []; return state.snapshot?.slices ?? state.snapshot?.exports ?? []; }
  function nodeSlices(node) {
    if(!node || !state.doc) return [];
    const ids=[node.figmaNodeId,node.raw?.id,node.raw?.exportNodeId].filter(value=>value!=null).map(String);
    return currentSlices().filter(slice=>[slice.exportNodeId,slice.figmaNodeId].filter(value=>value!=null).some(value=>ids.includes(String(value))));
  }
  function updatePropertyContext(openInspector=false) {
    const hasSlices=nodeSlices(state.doc?.byKey.get(state.selected)).length>0;
    setPropertyTab(hasSlices?'slices':'details');
    if(hasSlices&&openInspector) revealInspector();
  }
  function directoryRow(frame) {
    const row = el('div', 'ii-frame-row'); row.setAttribute('role', 'listitem'); row.dataset.frameId = frame.frameId;
    const select = button('', null, () => selectFrame(frame.frameId)); select.setAttribute('aria-label', frame.name); select.setAttribute('aria-current', frame.frameId === state.frameId ? 'true' : 'false');
    const preview = el('canvas', 'ii-frame-thumbnail'); preview.width = preview.height = 64; preview.setAttribute('aria-hidden', 'true');
    const previewStatus = el('span', 'ii-sr-only', tr('等待可见区预览请求；未声称已解码')); previewStatus.dataset.state = 'waiting';
    select.append(preview, previewStatus); directoryTargets.set(frame.frameId, { frame, canvas: preview, status: previewStatus });
    const content = el('span', 'ii-frame-name'); content.append(el('span', '', frame.name)); select.title = frame.name; select.append(content); row.append(select); return row;
  }
  function directoryGroup(name, key, values) {
    const group = el('details', 'ii-directory-group'), title = el('summary', '', name); title.title = name; group.dataset.key = key; group.open = !!search.value.trim() || !collapsedGroups.has(key); group.append(title, ...values);
    group.addEventListener('toggle', () => { if (group.open) collapsedGroups.delete(key); else collapsedGroups.add(key); requestRender(true); }); return group;
  }
  function renderDirectory() {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = ordered(state.frames).filter(frame => !query || `${frame.name} ${frame.frameId} ${frame.groupId ?? ''}`.toLocaleLowerCase().includes(query));
    clearDirectoryThumbnails(); countLabel.textContent = `${filtered.length} / ${state.frames.length}`; frameList.replaceChildren();
    const groups = Array.isArray(state.groups) ? state.groups : [];
    if (!directoryGroupsInitialized) {
      collapsedGroups.clear();
      if (groups.length) { for (const group of groups) collapsedGroups.add(String(group.id)); collapsedGroups.add('__none__'); }
      directoryGroupsInitialized = true;
    }
    const knownGroups = new Set(groups.map(group => String(group.id)));
    const ungrouped = filtered.filter(frame => !frame.groupId || !knownGroups.has(String(frame.groupId)));
    const current = state.frames.find(frame => frame.frameId === state.frameId);
    const currentKey = current ? (current.groupId && knownGroups.has(String(current.groupId)) ? String(current.groupId) : '__none__') : null;
    const frameChanged = Boolean(state.frameId && state.frameId !== lastDirectoryFrameId);
    if (currentKey && frameChanged) { collapsedGroups.delete(currentKey); lastDirectoryFrameId = state.frameId; }
    const sections = [];
    if (ungrouped.length) sections.push({ key: '__none__', name: tr('未分组'), frames: ungrouped });
    for (const group of groups) {
      const frames = filtered.filter(frame => String(frame.groupId ?? '') === String(group.id));
      const nameMatches = query && String(group.name).toLocaleLowerCase().includes(query);
      if (query && !frames.length && !nameMatches) continue;
      sections.push({ key: String(group.id), name: group.name, frames });
    }
    let currentRow = null;
    for (const section of sections) frameList.append(directoryGroup(`${section.name} · ${section.frames.length}`, section.key, section.frames.map(frame => { const row = directoryRow(frame); if (frame.frameId === state.frameId) currentRow = row; return row; })));
    if (currentRow && frameChanged) queueMicrotask(() => currentRow.scrollIntoView?.({ block: 'nearest' }));
    if (!filtered.length) frameList.append(ui('p', 'ii-empty', query ? '没有匹配的画板；目录未被截断。' : '本文件暂无画板。')); refreshContext(); requestRender(true);
  }
  async function openDirectoryFile(designFileId) {
    const request = directoryRequest.begin(); loadRequest.cancel(); download.cancel(); state.loading = true; state.doc = null; state.snapshot = null; state.selected = null; state.frameId = null; state.revisionId = null; clearImages(); renderSnapshot(); requestRender(true);
    try {
      const result = await adapter.listFrames({ designFileId, signal: request.signal }); if (!request.current() || state.disposed) return;
      const context = result?.context ?? adapter.context;
      if (!context || String(context.designFileId) !== String(designFileId)) throw new Error('跨文件目录缺少明确context更新；未混用其他文件');
      state.context = context; state.frames = normalizeDirectory(Array.isArray(result) ? result : result.frames); state.groups = Array.isArray(result?.groups) ? result.groups : []; directoryGroupsInitialized = false; lastDirectoryFrameId = null; state.loading = false; renderDirectory();
      if (state.frames.length) await selectFrame(state.frames[0].frameId); else { renderSnapshot(); requestRender(true); }
    } catch (error) { if (request.current() && !state.disposed) loadFailed(error); }
  }
  function renderTree() {
    tree.replaceChildren(); treeCount.textContent = state.doc ? String(state.doc.all.length) : '—';
    if (!state.doc) { tree.append(ui('p', 'ii-empty', state.loading ? '正在读取选中版本图层…' : '选择画板后读取一份版本树')); return; }
    const fragment = document.createDocumentFragment();
    state.doc.all.forEach((node, index) => {
      const row = button('', 'layer', event => chooseNode(node, event.shiftKey, { fromTree: true }), 'ii-tree-row'); row.style.paddingInlineStart = `${12 + Math.min(node.depth, 10) * 14}px`;
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(node.depth + 1)); row.setAttribute('aria-selected', String(state.selected === node.key)); row.dataset.key = node.key;
      row.title = `${node.name} · ${node.type}`; row.append(el('span', 'ii-tree-name', node.name), el('small', 'ii-muted', node.visible ? node.isMask ? '遮罩' : node.type : '隐藏'));
      row.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.doc.all.length - 1 : Math.max(0, Math.min(state.doc.all.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        const target = state.doc.all[next], chosen=chooseNode(target, event.shiftKey, { fromTree: true }); [...tree.children].find(child => child.dataset.key === (chosen?.key??target.key))?.focus();
      });
      fragment.append(row);
    });
    tree.append(fragment);
  }
  function scopedNode(node) {
    if(!node || !state.doc) return node;
    let selected=node, depth=node.depth;
    const isExport = parent => parent.type === 'SLICE' || Array.isArray(parent.raw?.exportSettings) && parent.raw.exportSettings.length > 0 || currentSlices().some(slice => String(slice.exportNodeId) === String(parent.figmaNodeId));
    for(let index=state.doc.all.indexOf(node)-1;index>=0;index--) {
      const parent=state.doc.all[index]; if(parent.depth>=depth) continue; depth=parent.depth;
      if(!preferences.inspectComponents && ['INSTANCE','COMPONENT','COMPONENT_SET'].includes(parent.type) || !preferences.inspectExports && isExport(parent)) selected=parent;
    }
    return selected;
  }
  function scopedHit(world) {const hit=hitTest(state.doc,world);if(!hit)return null;const node=scopedNode(hit.node);return node===hit.node?hit:{...hit,node,precision:nodePrecision(node)};}
  function chooseNode(node, asReference = false, { fromTree = false } = {}) {
    // Explicit tree rows identify the requested node. Scope preferences constrain
    // automatic canvas picking, not the user's deliberate choice of a tree row.
    const requested=node; node=fromTree ? node : scopedNode(node); if(!node)return null;
    if (fromTree) state.hovered = null;
    if (asReference && state.selected && state.selected !== node.key) state.reference = node.key;
    else { if (state.selected !== node.key) { state.selectedRun = null; state.selectedExportId=null; sliceScope.value='node'; } state.selected = node.key; state.reference = null; }
    for (const child of tree.children) child.setAttribute('aria-selected', String(child.dataset.key === state.selected));
    // Canvas selection must not override the user's directory tab.
    if (fromTree) setDirectoryTab('layers'); renderProperties();
    updatePropertyContext(true); renderSlices(); requestRender(true);
    const scopeApplied = !fromTree && (requested!==node || (!preferences.inspectComponents || !preferences.inspectExports) && node!==state.doc.frame);
    say(scopeApplied ? `${preferences.language==='en'?'Scope policy':'范围策略'}: ${node.name}` : `${node.name}${asReference ? ' · reference' : ''}`); return node;
  }
  // Missing/unknown values never become rows (including inside disclosures).
  const meaningful = field => field?.state === 'mixed' || field?.state === 'known' && field.value != null && (typeof field.value !== 'string' || field.value.trim() !== '');
  const fieldText = field => meaningful(field) ? stateText(field) : null;
  function lengthText(value) {
    const field = core.fieldState(value);
    if (field.state === 'mixed') return tr('混合（无单一值）');
    if (field.state !== 'known' || !finite(field.value)) return null;
    const result = core.displayValue(field, preferences);
    return result.state === 'known' ? result.text : null;
  }
  function propertySection(title, rows, userTitle=false, target=properties) {
    rows = rows.filter(([,value]) => value != null && String(value).trim() !== '');
    if (!rows.length) return null;
    const section = el('section', 'ii-property-section'); section.append(userTitle ? el('h3','',title) : ui('h3','',title)); const dl = el('dl', 'ii-property-grid');
    for (const [key, value] of rows) { dl.append(ui('dt', '', key), el('dd', '', String(value))); }
    section.append(dl); target.append(section); return section;
  }
  function opacityText(value) { return value?.state === 'known' && finite(value.value) ? `${numberText(value.value * 100, 4)}%` : fieldText(value); }
  function colorLine(parent, value, alpha = null) {
    if (!value) return;
    const line=el('div','ii-color-value'), swatch=el('span','ii-color-chip'); swatch.setAttribute('aria-hidden','true'); swatch.style.color=value;
    line.append(swatch,el('code','',value));
    if (alpha?.state === 'known' && finite(alpha.value) && alpha.value !== 1) line.append(el('span','ii-color-alpha',opacityText(alpha)));
    parent.append(line);
  }
  function activePaints(node, field) {
    const value = readField(node.raw, field);
    if (value.state !== 'known' || !Array.isArray(value.value)) return [];
    if (field === 'strokes') {
      const weights = ['strokeWeight','strokeTopWeight','strokeRightWeight','strokeBottomWeight','strokeLeftWeight'].map(key => readField(node.raw,key));
      const supplied = weights.filter(field => field.state === 'known' && finite(field.value));
      if (supplied.length && supplied.every(field => field.value === 0) && !weights.some(field => field.state === 'mixed')) return [];
    }
    return value.value.filter(paint => paint && paint.visible !== false && !(finite(paint.opacity) && paint.opacity === 0) && (paint.type === 'SOLID' ? !!paintColor(paint,preferences.colorFormat) && paint.color?.a !== 0 : typeof paint.type === 'string' && (paint.type.startsWith('GRADIENT_') && Array.isArray(paint.gradientStops) && paint.gradientStops.length > 0 || paint.type === 'IMAGE')));
  }
  function renderPaints(node,field,title,target) {
    const source=readField(node.raw,field);
    if(source.state==='mixed'){const section=propertySection(title,[[title,tr('混合（无单一值）')]],false,target);if(section){section.classList.add('ii-paints');section.dataset.field=field;}return;}
    const paints=activePaints(node,field); if(!paints.length)return;
    const section=el('section','ii-property-section ii-paints'); section.dataset.field=field; section.append(ui('h3','',title));
    paints.forEach((paint,index)=>{
      const row=el('div','ii-paint-row'); if(paints.length>1)row.append(el('span','ii-paint-number',String(index+1).padStart(2,'0')));
      if(paint.type==='SOLID')colorLine(row,paintColor(paint,preferences.colorFormat));
      else { row.append(el('span','ii-paint-kind',paint.type)); for(const stop of paint.gradientStops ?? [])colorLine(row,core.color(stop.color,preferences.colorFormat)); }
      section.append(row);
    });target.append(section);
  }
  function renderEffects(node,target) {
    const value=readField(node.raw,'effects');
    if(value.state==='mixed'){propertySection('阴影与效果',[['效果',tr('混合（无单一值）')]],false,target)?.classList.add('ii-effects');return;}
    if(value.state!=='known'||!Array.isArray(value.value))return;
    const effects=value.value.filter(effect=>{
      if(!effect||effect.visible===false)return false;
      if(['LAYER_BLUR','BACKGROUND_BLUR'].includes(effect.type))return finite(effect.radius)&&effect.radius>0;
      if(!['INNER_SHADOW','DROP_SHADOW'].includes(effect.type))return false;
      return !!core.color(effect.color,preferences.colorFormat)&&effect.color?.a!==0&&[effect.offset?.x,effect.offset?.y,effect.radius,effect.spread].some(value=>finite(value)&&value!==0);
    });if(!effects.length)return;
    const section=el('section','ii-property-section ii-effects');section.append(ui('h3','','阴影与效果'));
    effects.forEach((effect,index)=>{
      const card=el('article','ii-effect-card'),heading=el('div','ii-effect-heading');card.dataset.effectType=effect.type;
      const label=({INNER_SHADOW:'内阴影',DROP_SHADOW:'外阴影',LAYER_BLUR:'图层模糊',BACKGROUND_BLUR:'背景模糊'})[effect.type];
      heading.append(ui('h4','',label),el('span','ii-muted',String(index+1).padStart(2,'0')));card.append(heading);
      const grid=el('dl','ii-property-grid ii-effect-grid');
      const rows=[['水平偏移',lengthText(readField(effect.offset,'x'))],['垂直偏移',lengthText(readField(effect.offset,'y'))],['模糊',lengthText(readField(effect,'radius'))],['扩展',lengthText(readField(effect,'spread'))]];
      for(const [name,text]of rows)if(text!=null)grid.append(ui('dt','',name),el('dd','',text));if(grid.children.length)card.append(grid);
      colorLine(card,core.color(effect.color,preferences.colorFormat),readField(effect.color,'a'));section.append(card);
    });target.append(section);
  }
  function renderProperties() {
    properties.replaceChildren(); if(root.contains) for(const node of bindings.keys()) if(!root.contains(node)&&!cssDisclosure.contains?.(node)) bindings.delete(node); cssOutput.textContent = ''; cssWarnings.textContent = ''; state.cssGenerationWarnings = []; cssDisclosure.remove(); showAllSlices.remove(); cssOutput.hidden = cssTitle.hidden = preferences.stylesOnly;
    const node = state.doc?.byKey.get(state.selected);
    if (!node) { properties.append(ui('div', 'ii-empty', '点击图层查看尺寸、样式和文本。Shift点击另一图层测量间距。')); copyButton.disabled = true; return; }
    const advanced = disclosure('ii-advanced', '高级 / 图层详情');
    const selectedLayer = el('section','ii-selected-layer'), selectedName = el('h3','',node.name), selectedType = el('span','ii-layer-type',node.type); selectedName.title = node.name; selectedType.title = node.type; selectedLayer.append(selectedName,selectedType); properties.append(selectedLayer);
    copyButton.disabled = preferences.stylesOnly; if(preferences.stylesOnly) {properties.append(ui('p','ii-note','仅显示样式与组件信息；几何和文本内容暂不展示。'));renderReferences(node,{metadataOnly:true,advanced});if(advanced.children.length>1)properties.append(advanced);details.append(showAllSlices);return;} const m = measurements(node), raw = node.raw;
    const selectedMeta = el('dl','ii-layer-meta');
    if(node.visibilityState.state==='known'&&node.visibilityState.value===false)selectedMeta.append(ui('dt','','可见性'),el('dd','','隐藏'));
    if(node.opacity.state==='mixed'||node.opacity.state==='known'&&finite(node.opacity.value)&&node.opacity.value!==1)selectedMeta.append(ui('dt','','透明度'),el('dd','',opacityText(node.opacity)));
    if(selectedMeta.children.length)selectedLayer.append(selectedMeta);
    // Display already-normalized geometry only; a world BBox is never relabelled as local size.
    const worldSizeKnown = finite(node.bounds?.width) && finite(node.bounds?.height), geometry = raw.geometry && typeof raw.geometry==='object' ? {...raw,...raw.geometry} : raw;
    const positionKnown=['absoluteBoundingBox','absoluteTransform','relativeTransform'].some(key=>readField(geometry,key).state==='known')||['x','y'].every(key=>readField(geometry,key).state==='known');
    const withPosition=['FRAME','GROUP','COMPONENT','COMPONENT_SET','INSTANCE','SLICE'].includes(node.type)&&positionKnown;
    const primarySize=worldSizeKnown?node.bounds:{width:readField(geometry,'width'),height:readField(geometry,'height')};
    const dimensions=propertySection(worldSizeKnown?'尺寸 / 世界BBox':'尺寸 / 局部尺寸',[...(withPosition?[['X',lengthText(node.bounds?.x)],['Y',lengthText(node.bounds?.y)]]:[]),['W',lengthText(primarySize.width)],['H',lengthText(primarySize.height)]]);
    if(dimensions){dimensions.classList.add('ii-geometry');dimensions.dataset.basis=worldSizeKnown?'world-bounds':'local';}
    const transformed=finite(m.localWidth)&&finite(m.localHeight)&&worldSizeKnown&&(Math.abs(m.localWidth-node.bounds.width)>1e-8||Math.abs(m.localHeight-node.bounds.height)>1e-8);
    const geometryRows=[];
    if(transformed)geometryRows.push(['局部宽',lengthText(m.localWidth)],['局部高',lengthText(m.localHeight)],['变换后边长',lengthText(m.transformedWidth)!=null&&lengthText(m.transformedHeight)!=null?`${lengthText(m.transformedWidth)} × ${lengthText(m.transformedHeight)}`:null]);
    if(['absoluteTransform','relativeTransform'].some(key=>readField(geometry,key).state==='known'))geometryRows.push(['矩阵 2×3',node.matrix.map(n=>numberText(n)).join(', ')]);
    for(const key of ['rotation','flipX','flipY']){const field=readField(raw,key);if(field.state==='mixed'||field.state==='known'&&(key==='rotation'?finite(field.value)&&field.value!==0:field.value===true))geometryRows.push([key,fieldText(field)]);}
    propertySection('几何详情',geometryRows,false,advanced);
    const appearance=[];
    for(const [key,label]of [['cornerRadius','圆角'],['rectangleCornerRadii','四角']]){const field=readField(raw,key);if(field.state==='mixed')appearance.push([label,fieldText(field)]);else if(field.state==='known'&&(finite(field.value)&&field.value>0||Array.isArray(field.value)&&field.value.some(value=>finite(value)&&value>0)))appearance.push([label,Array.isArray(field.value)?field.value.map(value=>lengthText(value)).filter(value=>value!=null).join(' / '):lengthText(field)]);}
    if(activePaints(node,'strokes').length)for(const [key,label]of [['strokeWeight','描边宽'],['strokeTopWeight','上描边'],['strokeRightWeight','右描边'],['strokeBottomWeight','下描边'],['strokeLeftWeight','左描边']]){const field=readField(raw,key);if(field.state==='mixed'||field.state==='known'&&finite(field.value)&&field.value>0)appearance.push([label,lengthText(field)]);}
    if(activePaints(node,'strokes').length)appearance.push(['描边对齐',fieldText(readField(raw,'strokeAlign'))]);
    for(const [key,label]of [['clipsContent','裁剪'],['isMask','遮罩']])if(readField(raw,key).value===true)appearance.push([label,'true']);
    propertySection('外观',appearance);
    const settings = { ...preferences, unit: ['dp','rpx'].includes(preferences.unit) ? 'px' : preferences.unit, rpxBase: preferences.rpxBase, multiFill: true, paintOrder: 'bottom-first' };
    for (const [field,title] of [['fills','颜色与填充'],['strokes','描边']])renderPaints(node,field,title,properties);
    renderEffects(node,properties);
    if (raw.type === 'TEXT' || raw.characters !== undefined || raw.textTable) {
      const segments = typeof core.textSegments === 'function' ? core.textSegments(node) : { ...typography(node), coverage: {state:'unknown'}, warnings: [], source: 'runs' };
      const textControls = el('section', 'ii-text-controls'); textControls.append(ui('h3', '', '文本选择'));
      const runSelect = el('select'); bindUI(runSelect,'选择真实文本段','aria-label'); const fullOption = ui('option', '', '全文（保留混合状态）'); fullOption.value = ''; runSelect.append(fullOption);
      segments.runs.forEach((run, index) => { const range=Number.isSafeInteger(run.start)&&Number.isSafeInteger(run.end)?` · [${run.start}–${run.end}]`:''; const option = el('option', '', `${index + 1}${range}${typeof run.characters==='string'?` ${run.characters}`:''}`); option.value = String(index); runSelect.append(option); });
      runSelect.value = state.selectedRun == null ? '' : String(state.selectedRun); runSelect.addEventListener('change', () => { state.selectedRun = runSelect.value === '' ? null : Number(runSelect.value); renderProperties(); });
      const selectedRun = state.selectedRun == null ? null : segments.runs[state.selectedRun];
      if (selectedRun) settings.runIndex = state.selectedRun;
      const selectedText = selectedRun ? selectedRun.characters : segments.characters?.state === 'known' ? segments.characters.value : null;
      const textValue = el('pre', 'ii-text-value', typeof selectedText === 'string' ? selectedText : ''); textValue.tabIndex = 0;
      const copyTextButton = button(selectedRun ? '复制所选段' : '复制全文', null, () => copyText(selectedText, textValue)); copyTextButton.disabled = typeof selectedText !== 'string';
      const copyAll = button('复制完整文本', null, () => copyText(segments.characters?.value, textValue)); copyAll.disabled = segments.characters?.state !== 'known';
      if(segments.runs.length)textControls.append(runSelect);
      if(typeof selectedText==='string')textControls.append(textValue,copyTextButton);
      if(segments.characters?.state==='known')textControls.append(copyAll);
      if(textControls.children.length>1)properties.append(textControls);
      const t = typography(selectedRun ? { type: 'TEXT', characters: selectedRun.characters, style: selectedRun.style } : node); propertySection(selectedRun ? `文本段 ${state.selectedRun + 1} / 字体` : '文本 / 字体', Object.entries(t.properties).map(([key, value]) => [key,fieldText(value)]));
      if (selectedRun) propertySection('所选文本段属性', [['区间',Number.isSafeInteger(selectedRun.start)&&Number.isSafeInteger(selectedRun.end)?`${selectedRun.start}–${selectedRun.end}`:null]],false,advanced);
    }
    renderReferences(node,{advanced});
    const reference = state.doc.byKey.get(state.reference);
    if (reference) { const s = spacing(node, reference); propertySection(`间距：${reference.name}`, [['方式', '世界轴对齐bounds（旋转非轮廓间距）'], ['水平间隔', `${numberText(s.horizontalGap)}${s.overlapX ? '（重叠）' : ''}`], ['垂直间隔', `${numberText(s.verticalGap)}${s.overlapY ? '（重叠）' : ''}`], ['左 / 上偏移', `${numberText(s.left)} / ${numberText(s.top)}`]]); }
    if(advanced.children.length>1)properties.append(advanced);
    try { const generated = generateCSS(node, settings); state.cssGenerationWarnings = [...generated.warnings]; const unitNote = ['dp','rpx'].includes(preferences.unit) ? `显示单位${preferences.unit}不是标准CSS长度；复制使用源px。` : ''; cssOutput.textContent = generated.text ? (unitNote ? `/* ${unitNote} */\n` : '') + generated.text : ''; cssWarnings.textContent = generated.text ? unitNote : ''; if(generated.text)details.append(cssDisclosure);else copyButton.disabled=true; }
    catch (error) { cssWarnings.textContent = displayError(errorText(error)); copyButton.disabled = true; }
    details.append(showAllSlices);
  }
  function renderReferences(node, {metadataOnly=false,advanced=properties} = {}) {
    const refs = typeof core.resolveNodeReferences === 'function' ? core.resolveNodeReferences(state.doc,node) : null;
    const labels = {textStyleId:'文字样式',fillStyleId:'填充样式',strokeStyleId:'描边样式',effectStyleId:'效果样式',gridStyleId:'网格样式'};
    const styles=(refs?.styles??[]).filter(item=>item.state==='resolved'&&typeof item.value?.name==='string'&&item.value.name.trim());
    const component=refs?.component?.state==='resolved'?refs.component.value:null;
    const rows=(refs?.styles??[]).filter(item=>item.state==='mixed'||styles.includes(item)).map(item=>[labels[item.field],item.state==='mixed'?tr('混合（无单一值）'):item.value.name]);
    if(refs?.component?.state==='mixed')rows.push(['组件',tr('混合（无单一值）')]);
    if(typeof component?.name==='string'&&component.name.trim())rows.push(['组件',component.name]);
    const summary=propertySection('组件 / 样式引用',rows);if(summary)summary.classList.add('ii-reference-summary');
    if(typeof component?.description==='string'&&component.description.trim())propertySection('组件详情',[['描述',component.description]]);
    const variants=refs?.variants?.value??component?.variantProperties??component?.variants;
    if(variants&&typeof variants==='object'&&!Array.isArray(variants))propertySection('组件变体',Object.entries(variants).filter(([name,value])=>!new Set(['id','key','hash','projectId','designFileId','fileId','pageId','frameId','revisionId','assetId','sliceId','nodeId','figmaNodeId','styleId','componentId','componentKey','styleKey','sessionId','imageHash','componentReference','styleReference','refId','referenceId']).has(name)&&['string','number','boolean'].includes(typeof value)&&(typeof value!=='number'||finite(value))).map(([name,value])=>[name,String(value)]),false,advanced);
    // A selected element's resolved styles only; unrelated/empty global categories never occupy the rail.
    const catalog=el('section','ii-style-catalog');catalog.append(ui('h3','','分类样式目录 / 实际值'));
    for(const item of styles){
      const style=item.value,card=el('details','ii-style-card');card.append(el('summary','',`${tr(labels[item.field])} · ${style.name}`));
      if(typeof style.description==='string'&&style.description.trim())card.append(el('p','ii-note',style.description));
      const styleRows=Object.entries(style).filter(([key])=>designFields.has(key)&&!['name','description','type','state'].includes(key)).map(([key,value])=>{
        const field=core.fieldState(value);if(!meaningful(field))return [key,null];
        if(typeof field.value==='object')return [key,null];return [key,fieldText(field)];
      });propertySection('样式信息',styleRows,false,card);
      // Structured known paints/effects keep color and true parameters, never reference IDs or raw JSON.
      for(const [field,title]of [['fills','颜色与填充'],['strokes','描边']])renderPaints({raw:style},field,title,card);
      renderEffects({raw:style},card);catalog.append(card);
    }
    if(catalog.children.length>1)advanced.append(catalog);
  }
  async function copyText(value, fallback) {
    try { if (typeof value !== 'string' || !window.navigator.clipboard?.writeText) throw new Error('安全剪贴板不可用，请在文本区手动选择复制'); await window.navigator.clipboard.writeText(value); say('已复制所选真实文本；Unicode未改写'); }
    catch (error) { fallback?.focus?.(); say(errorText(error),true); }
  }
  async function copyCSS() {
    try { if (!window.navigator.clipboard?.writeText) throw new Error('当前环境不支持安全剪贴板；请选择CSS文本复制'); await window.navigator.clipboard.writeText(cssOutput.textContent); say('已复制当前已知CSS；不是完整设计复现'); }
    catch (error) { say(errorText(error), true); }
  }
  function revisionDisplay(revision, index) {
    // Backend labels may combine a design name and a revision key; they are not design names.
    const name = typeof revision.name === 'string' && revision.name.trim() ? revision.name : null;
    const time = [revision.publishedAt, revision.createdAt].find(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(value) && Number.isFinite(Date.parse(value)));
    const fallback = preferences.language === 'en' ? `History entry ${index + 1}` : `历史记录第${index + 1}项`;
    return [tr(revisionStatus(revision.revisionId)), name ?? (revisionStatus(revision.revisionId) === '历史版本' ? fallback : null), time].filter(Boolean).join(' · ');
  }
  function renderRevisions() {
    revisionSelect.replaceChildren();
    for (const [index,revision] of state.revisions.entries()) { const option = el('option', '', revisionDisplay(revision, index)); option.value = revision.revisionId; option.title = option.textContent; option.selected = revision.revisionId === state.revisionId; revisionSelect.append(option); }
  }
  function renderSnapshot() {
    identityBox.replaceChildren();
    if (!state.doc) identityBox.append(el('p', 'ii-empty', state.loading ? tr('正在加载所查看版本…') : state.error ? `${tr('加载失败')}: ${displayError(state.error)}` : tr('未选择画板')));
    renderTree(); renderProperties(); renderSlices(); refreshControls();
  }
  function renderSlices() {
    sliceList.replaceChildren(); sliceTargets.clear(); const selected = state.doc?.byKey.get(state.selected), selectedSlices=nodeSlices(selected);
    const values = sliceScope.value === 'frame' ? currentSlices() : selectedSlices;
    sliceCount.textContent = values.length ? `${values.length} / ${currentSlices().length} ${preferences.language === 'en' ? 'exports' : '项'} · ${tr(revisionStatus())}` : '';
    if (!values.length) sliceList.append(ui('p', 'ii-empty', sliceScope.value==='node' ? '此元素没有切图' : '所查看版本没有切图。不会混入最新版本。'));
    const chosen=values.find(slice=>(slice.sliceId ?? slice.assetId)===state.selectedExportId) ?? values[0]; state.selectedExportId=chosen?.sliceId??chosen?.assetId??null;
    slices.replaceChildren(sliceScopeLabel,sliceCount,sliceList,...(state.propertyTab==='slices'&&sliceScope.value==='node'&&selectedSlices.length?[showAllSlices]:[]),zipButton,scopeNote,downloadStatus,cancelDownload,checkedDownload);
    for (const raw of values) {
      const slice = descriptorOf(raw), card = el('section', 'ii-slice-card'); card.dataset.sliceId = slice.sliceId ?? ''; const mime = slice.mime ?? ({ PNG:'image/png', JPG:'image/jpeg', JPEG:'image/jpeg', WEBP:'image/webp', SVG:'image/svg+xml', PDF:'application/pdf' }[String(slice.format).toUpperCase()] ?? '未知格式');
      const active=raw===chosen;card.dataset.selected=String(active);
      const name=slice.exportName ?? slice.name ?? slice.filename ?? '切图',title=el('h3'),choose=button('',null,()=>{
        state.selectedExportId=slice.sliceId ?? slice.assetId;renderSlices();requestRender(true);
        [...sliceList.querySelectorAll('button')].find(node=>node.dataset.selectSlice===String(state.selectedExportId))?.focus();
      },'ii-export-select');choose.textContent=name;choose.setAttribute('aria-label',`查看切图 · ${name}`);choose.dataset.selectSlice=String(slice.sliceId ?? slice.assetId);choose.setAttribute('aria-pressed',String(active));choose.title=name;title.append(choose);
      const constraint=slice.pluginExportSetting?.constraint;
      const scale=finite(slice.scale)&&slice.scale>0 ? `${numberText(slice.scale)}×` : constraint?.type==='SCALE'&&finite(constraint.value)&&constraint.value>0 ? `${numberText(constraint.value)}×` : ['WIDTH','HEIGHT'].includes(constraint?.type)&&finite(constraint.value)&&constraint.value>0 ? `${tr(constraint.type==='WIDTH'?'固定宽度':'固定高度')} ${numberText(constraint.value)}px` : null;
      const metadata=el('p','ii-muted',[slice.format ?? (mime==='未知格式'?null:mime),scale].filter(Boolean).join(' · '));title.title=name;card.append(title);if(metadata.textContent){metadata.title=metadata.textContent;card.append(metadata);}
      const pixels=Number.isSafeInteger(slice.width)&&slice.width>0&&Number.isSafeInteger(slice.height)&&slice.height>0 ? `${slice.width} × ${slice.height} px` : null;
      if(pixels){const dimensions=el('p','ii-export-dimensions',pixels);dimensions.title=tr('实际导出');card.append(dimensions);}
      const previewable = ['image/png','image/jpeg','image/webp','image/gif'].includes(mime) || adapter.previewCapabilities?.rasterizeFormats?.includes(mime) === true;
      // Thumbnails require the existing bounded derivative route; never decode the original PNG here.
      if (previewable && slice.assetId && typeof adapter.getPreview === 'function') {
        const preview = el('canvas', 'ii-slice-preview'); preview.width = active ? 256 : 96; preview.height = active ? 160 : 96; preview.setAttribute('role', 'img'); preview.setAttribute('aria-label', `${name}的有界预览；原格式 ${slice.format ?? mime}`);
        const previewStatus = ui('p', 'ii-slice-preview-status', '等待可见区预览请求；未声称已解码'); previewStatus.dataset.state = 'waiting'; card.append(preview,previewStatus); sliceTargets.set(`${slice.sliceId ?? slice.assetId}`, { asset: {...slice,mime}, canvas: preview, status: previewStatus });
      } else {
        const placeholder = el('span','ii-slice-placeholder',String(slice.format ?? mime.split('/').at(-1)).toUpperCase()), previewNote = ui('p','ii-slice-preview-status',previewable ? slice.assetId ? '宿主未提供有界缩略图；原格式仍可下载。' : '缺少预览资源；仍需宿主提供原格式授权下载。' : '原格式下载，暂不提供栅格预览。'); placeholder.title = previewNote.textContent; card.append(placeholder,previewNote);
      }
      const setting = el('details','ii-slice-advanced'), settingSummary = el('summary'), settingBody = el('div','ii-slice-export-details'); setting.open = false; bindUI(settingSummary,'高级 / 导出详情','title'); settingSummary.append(icon('more',document),ui('span','ii-sr-only','高级 / 导出详情')); setting.append(settingSummary,settingBody);
      const exportInfo=[finite(slice.width)&&finite(slice.height)?`${numberText(slice.width)} × ${numberText(slice.height)}`:null,Number.isSafeInteger(slice.byteLength)&&slice.byteLength>=0?`${slice.byteLength} bytes`:null].filter(value=>value!=null).join(' · ');
      if(exportInfo)settingBody.append(el('p','ii-note',exportInfo));
      const exportSetting=slice.pluginExportSetting;
      if(exportSetting)propertySection('导出设置',[['format',typeof exportSetting.format==='string'?exportSetting.format:null],['suffix',typeof exportSetting.suffix==='string'&&exportSetting.suffix?exportSetting.suffix:null],...['contentsOnly','useAbsoluteBounds'].map(key=>[key,typeof exportSetting[key]==='boolean'?String(exportSetting[key]):null])],false,settingBody);
      if(settingBody.children.length)card.append(setting);
      const action = button('下载原格式', 'download', () => startDownload('slice', slice.sliceId),active ? 'ii-primary ii-export-download' : 'ii-icon-only'); action.title = `${tr('下载原格式')} · ${name}`; action.disabled = !slice.sliceId || ['preparing','checking','cancelling','notSavedYet','unknown'].includes(download.state); action.dataset.unavailable = String(!slice.sliceId); card.append(action); sliceList.append(card);
    }
    renderDownload(download.diagnostics);
  }
  function renderDownload(value) {
    downloadStatus.textContent = value.state === 'error' ? displayError(value.message) : value.message; cancelDownload.hidden = !['preparing', 'checking'].includes(value.state); checkedDownload.hidden = !['notSavedYet', 'unknown'].includes(value.state); refreshControls();
    for (const n of sliceList.querySelectorAll('button')) n.disabled = n.dataset.unavailable === 'true' || ['preparing', 'checking', 'cancelling', 'notSavedYet', 'unknown'].includes(value.state);
    if (value.state === 'error' && !libraryLink.hidden) downloadStatus.textContent += ' 超限或不可准备时，请使用顶部「切图」查看项目当前版本切图库；此处不改成最新版本ZIP。';
  }
  function startDownload(kind, sliceId = null) { if (state.loading || !state.doc) return; download.start({ frameId: state.frameId, revisionId: state.revisionId, kind, sliceId }); }
  function clearImages() { for (const target of directoryTargets.values()) { target.canvas.getContext('2d')?.clearRect(0, 0, target.canvas.width, target.canvas.height); target.status.textContent = tr('等待可见区预览请求；未声称已解码'); target.status.dataset.state = 'waiting'; } state.lastImageSignature = ''; state.imagePlans.clear(); lowCache.clear(); state.imageErrors.clear(); state.imageGeneration++; scheduler.protectKeys([]); scheduler.setGeneration(state.imageGeneration); }
  function actualRevisionId(requested, frame, revisions) {
    if (requested !== 'current') return requested;
    const actual = frame.currentRevisionId ?? revisions.find(revision => revision.current === true)?.revisionId ?? (frame.revisionId !== 'current' ? frame.revisionId : null);
    if (!actual || actual === 'current') throw new Error('current别名缺少真实currentRevisionId；未猜测版本身份'); return String(actual);
  }
  async function selectFrame(frameId, preferredRevision = null, navigation = {}) {
    const frame = state.frames.find(f => f.frameId === String(frameId)); if (!frame || state.disposed) return;
    state.lastTarget = {frameId:frame.frameId,revisionId:preferredRevision};
    setDirectoryTab('frames');
    const request = loadRequest.begin(); state.frameId = frame.frameId; state.revisionId = null; state.revisions = []; state.snapshot = null; state.doc = null; state.selected = null; state.reference = null; state.hovered = null; state.loading = true; state.error = null; state.selectedRun = null; state.selectedExportId=null; sliceScope.value='node'; setPropertyTab('details'); clearImages(); download.cancel();
    renderDirectory(); renderRevisions(); renderSnapshot(); say(preferences.language==='en' ? `Loading revision directory for ${frame.name}…` : `加载画板 ${frame.name} 的版本目录…`); requestRender(true);
    try {
      const rawRevisions = await adapter.listRevisions(frame.frameId, { signal: request.signal });
      if (!request.current() || state.disposed) return;
      const revisions = normalizeRevisions(rawRevisions).map(revision => ({ ...revision, current: rawRevisions.find(raw => String(raw.revisionId ?? raw.id) === revision.revisionId)?.current === true })); state.revisions = revisions;
      const wanted = actualRevisionId(preferredRevision ?? frame.currentRevisionId ?? frame.latestRevisionId ?? frame.revisionId, frame, revisions);
      const revision = wanted ? revisions.find(r => r.revisionId === String(wanted)) : revisions.find(r => r.current) ?? revisions[0];
      if (!revision) { if (preferredRevision) throw new Error('指定历史版本不存在；未回退为最新版本'); state.loading = false; state.error = '画板尚无已发布版本'; renderSnapshot(); say(state.error); requestRender(true); return; }
      state.revisionId = revision.revisionId; renderRevisions();
      await loadSelectedRevision(frame, revision.revisionId, request, navigation);
    } catch (error) { if (request.current() && !state.disposed) loadFailed(error); }
  }
  async function selectRevision(revisionId, navigation = {}) {
    const frame = currentFrame(); if (!frame || state.disposed) return;
    try { revisionId = actualRevisionId(String(revisionId),frame,state.revisions); if (!state.revisions.some(revision => revision.revisionId === revisionId)) throw new Error('指定历史版本不存在；未回退为最新版本'); } catch (error) { loadFailed(error); return; }
    state.lastTarget = {frameId:frame.frameId,revisionId};
    const request = loadRequest.begin(); state.revisionId = String(revisionId); state.snapshot = null; state.doc = null; state.selected = null; state.reference = null; state.hovered = null; state.loading = true; state.error = null; state.selectedRun = null; state.selectedExportId=null; sliceScope.value='node'; setPropertyTab('details'); clearImages(); download.cancel(); renderSnapshot(); requestRender(true);
    try { await loadSelectedRevision(frame, String(revisionId), request, navigation); } catch (error) { if (request.current() && !state.disposed) loadFailed(error); }
  }
  async function loadSelectedRevision(frame, revisionId, request, navigation = {}) {
    const snapshot = await adapter.loadRevision(frame.frameId, revisionId, { signal: request.signal });
    if (!request.current() || state.disposed) return;
    const declaredFrame = snapshot.identity?.frameId ?? snapshot.frameId, declaredRevision = snapshot.identity?.revisionId ?? snapshot.revisionId;
    if (declaredFrame == null || declaredRevision == null) throw new Error('宿主缺少画板/版本身份；不能证实当前版本，已拒绝加载');
    if (declaredFrame != null && String(declaredFrame) !== frame.frameId || declaredRevision != null && String(declaredRevision) !== revisionId) throw new Error('宿主返回了不同画板/版本；已拒绝混入');
    const context = snapshot.context ?? adapter.context ?? state.context;
    const fileId = snapshot.identity?.designFileId ?? snapshot.designFileId ?? frame.designFileId;
    if (state.context?.designFileId && String(fileId) !== String(state.context.designFileId) && String(context?.designFileId) !== String(fileId)) throw new Error('跨文件导航必须更新context或进行页面导航；未混用文件上下文');
    const projectId = snapshot.identity?.projectId ?? snapshot.projectId ?? frame.projectId;
    if (frame.projectId && projectId && String(frame.projectId) !== String(projectId) || state.context.projectId && projectId && String(state.context.projectId) !== String(projectId)) throw new Error('版本项目身份不匹配；拒绝跨项目数据');
    for (const field of ['designFileId','pageId']) if (String(revisionId) === String(frame.currentRevisionId ?? frame.latestRevisionId ?? frame.revisionId) && frame[field] != null && snapshot.identity?.[field] != null && String(frame[field]) !== String(snapshot.identity[field])) throw new Error(`当前版本${field}身份不匹配；拒绝混入文件/页面`);
     if (snapshot.identity?.designFileId != null && context?.designFileId != null && String(snapshot.identity.designFileId) !== String(context.designFileId)) throw new Error('版本来源文件与上下文不匹配；拒绝混入');
    if (context?.projectId != null && projectId != null && String(context.projectId) !== String(projectId)) throw new Error('宿主context项目身份不匹配');
    if (!Array.isArray(snapshot.slices ?? snapshot.exports ?? [])) throw new Error('当前版本切图目录格式无效');
    const identity = { ...frame, ...snapshot, ...snapshot.identity, frameId: frame.frameId, revisionId, figmaNodeId: snapshot.identity?.figmaNodeId ?? snapshot.figmaNodeId ?? frame.figmaNodeId ?? snapshot.layerDoc?.frame?.id };
    const doc = normalizeLayerDoc(snapshot.layerDoc, identity);
    if (doc.identity.figmaNodeId != null && String(doc.raw.frame.id) !== doc.identity.figmaNodeId) throw new Error('LayerDoc平台节点身份不匹配');
    for (const value of [snapshot.previewAsset, ...(snapshot.assets ?? []), ...(snapshot.slices ?? snapshot.exports ?? [])].filter(Boolean)) if (value.revisionId != null && String(value.revisionId) !== revisionId || value.frameId != null && String(value.frameId) !== frame.frameId) throw new Error('资源身份与当前版本不符');
    state.context = context ?? {}; state.snapshot = snapshot; state.doc = doc; applyDesignPreferences(snapshot); state.loading = false; state.selected = doc.frame.key; state.fitPending = true; renderSnapshot(); renderDirectory(); fitView(); say(preferences.language==='en' ? `Loaded · ${doc.all.length} layers · Read only` : `已载入 · ${doc.all.length} 图层 · 只读`); requestRender(true); await commitLocation(navigation);
  }
  function loadFailed(error) { state.loading = false; state.error = errorText(error); state.snapshot = null; state.doc = null; state.selected = null; state.selectedRun = null; state.selectedExportId=null; sliceScope.value='node'; setPropertyTab('details'); clearImages(); renderSnapshot(); say(state.error, true); requestRender(true); }
  async function retryLoad() {
    if (state.lastTarget && state.frames.length) return selectFrame(state.lastTarget.frameId,state.lastTarget.revisionId,{replace:true});
    const request = directoryRequest.begin(); state.loading = true; state.error = null; refreshControls(); requestRender(true);
    try { const result = await adapter.listFrames({signal:request.signal}); if (!request.current() || state.disposed) return; state.context = result?.context ?? adapter.context ?? {}; state.frames = normalizeDirectory(Array.isArray(result) ? result : result.frames); state.groups = Array.isArray(result?.groups) ? result.groups : []; directoryGroupsInitialized = false; lastDirectoryFrameId = null; state.loading = false; renderDirectory(); if (state.frames.length) await selectFrame(initialFrameId ?? state.frames[0].frameId,initialRevisionId,{replace:true}); else {renderSnapshot();requestRender(true);} } catch (error) { if(request.current()&&!state.disposed) loadFailed(error); }
  }
  function projectDirectory() { const frames = state.context.designFileId ? state.frames.filter(frame => String(frame.designFileId) === String(state.context.designFileId)) : state.frames; return frames.map(frame => frame.frameId === state.frameId ? { ...frame, name: selectedRevisionName(), bounds: state.doc?.frame.bounds ?? frame.bounds } : frame); }
  function fitBounds() { return state.mode === 'project' ? unionBounds(projectDirectory().map(f => f.bounds)) ?? state.doc?.frame.bounds : state.doc?.frame.bounds ?? currentFrame()?.bounds; }
  function fitView(scale = null) { const bounds = fitBounds(); if (!bounds) return; state.v = fit(state.v, bounds, 40, scale); state.fitPending = false; refreshControls(); requestRender(true); }
  function changeZoom(factor, point = { x: state.v.width / 2, y: state.v.height / 2 }) { state.v = zoomAt(state.v, point, factor); refreshControls(); requestRender(true); }
  function requestRender(images = false) {
    if (state.disposed) return; needsImageRefresh ||= images;
    if (!raf) raf = window.requestAnimationFrame(() => { raf = 0; draw(); if (needsImageRefresh) { needsImageRefresh = false; refreshImages(); } });
  }
  function paintBounds(bounds, fill, stroke = null, label = '') {
    if (!bounds) return; const p = worldToScreen(state.v, bounds), w = bounds.width * state.v.scale, h = bounds.height * state.v.scale;
    ctx.fillStyle = fill; ctx.fillRect(p.x, p.y, w, h); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(p.x, p.y, w, h); }
    if (label && w > 40 && state.v.scale > 0.2) { ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y - 24, w, 24); ctx.clip(); ctx.fillStyle = canvasChrome.text; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(label, p.x, p.y - 8); ctx.restore(); }
  }
  function nodeOutline(node) {
    if (!node) return null;
    const raw = node.raw ?? {}, geometry = raw.geometry && typeof raw.geometry === 'object' ? { ...raw, ...raw.geometry } : raw;
    const known = key => { const field = readField(geometry, key); return field.state === 'known' ? field.value : null; };
    const worldBounds = core.rect(known('absoluteBoundingBox'));
    const hasTransform = core.affine(known('absoluteTransform')) || core.affine(known('relativeTransform'));
    // A world AABB is already in world coordinates. Without a confirmed matrix,
    // do not reinterpret its origin as a local rotated rectangle.
    const boundsOnly = !node.local || Boolean(worldBounds && !hasTransform);
    const bounds = boundsOnly ? worldBounds ?? node.bounds : null;
    const points = bounds ? corners(bounds) : node.local ? corners(node.local, node.matrix) : null;
    return points?.every(point => finite(point.x) && finite(point.y)) ? { points, boundsOnly } : null;
  }
  function drawNodeOutline(node, stroke, dash = [], selected = false) {
    const outline = nodeOutline(node); if (!outline) return;
    const points = outline.points.map(point => worldToScreen(state.v, point));
    ctx.save(); ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    ctx.setLineDash(outline.boundsOnly && !dash.length ? [4, 3] : dash);
    if (selected) { ctx.strokeStyle = '#081a1e'; ctx.lineWidth = 4; ctx.stroke(); }
    ctx.strokeStyle = stroke; ctx.lineWidth = selected ? 2 : 1.5; ctx.stroke();
    if (selected) {
      ctx.setLineDash([]); ctx.fillStyle = canvasChrome.panel; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
      for (const p of points) { ctx.fillRect(p.x - 3, p.y - 3, 6, 6); ctx.strokeRect(p.x - 3, p.y - 3, 6, 6); }
    }
    ctx.restore();
  }
  function canvasFrames() {
    if (state.mode === 'frame') { const frame = currentFrame(), bounds = state.doc?.frame.bounds ?? frame?.bounds; return frame && intersects(bounds, visibleWorld(state.v)) ? [{ ...frame, name: selectedRevisionName(), bounds }] : []; }
    return visibleMetadata(projectDirectory(), state.v);
  }
  function stageFrames() {
    return state.mode === 'frame' ? canvasFrames() : visibleFrames(projectDirectory(), state.v);
  }
  function metadataHit(world) {
    if (state.mode !== 'project') return null;
    // The bounded interactive index is an optimization, never a selection cutoff.
    for (let i = state.paintFrames.length - 1; i >= 0; i--) { const frame = state.paintFrames[i], b = frame.bounds; if (b && world.x >= b.x && world.x <= b.x + b.width && world.y >= b.y && world.y <= b.y + b.height) return frame; }
    return null;
  }
  function draw() {
    if (state.disposed) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, state.v.width, state.v.height);
    state.renderedFrames = stageFrames(); state.paintFrames = canvasFrames(); state.imageDrawCalls = 0;
    const painted = new Set();
    for (const frame of state.paintFrames) paintBounds(frame.bounds, canvasChrome.panel, canvasChrome.line, frame.name);
    for (const plan of state.imagePlans.values()) {
      const resource = scheduler.get(plan.key); if (!resource?.bitmap) continue;
      if (plan.target) { if(root.contains && !root.contains(plan.target.canvas))continue; const c = plan.target.canvas, context = c.getContext('2d'); if (context) { context.clearRect(0, 0, c.width, c.height); const ratio = Math.min(c.width / resource.width, c.height / resource.height); context.drawImage(resource.bitmap, (c.width - resource.width * ratio) / 2, (c.height - resource.height * ratio) / 2, resource.width * ratio, resource.height * ratio); plan.target.status.textContent = tr('预览已加载'); plan.target.status.dataset.state = 'ready'; } continue; }
      const p = worldToScreen(state.v, plan.bounds);
      ctx.drawImage(resource.bitmap, p.x, p.y, plan.bounds.width * state.v.scale, plan.bounds.height * state.v.scale);
      painted.add(plan.frame.frameId); state.imageDrawCalls++;
    }
    state.paintedImageFrames = painted.size;
    if (state.hoveredFrameId) { const frame = state.paintFrames.find(f => f.frameId === state.hoveredFrameId); if (frame?.bounds) { const p = worldToScreen(state.v, frame.bounds); ctx.strokeStyle = canvasChrome.selection; ctx.lineWidth = 2; ctx.strokeRect(p.x, p.y, frame.bounds.width * state.v.scale, frame.bounds.height * state.v.scale); } }
    if (state.doc) { const selected = state.doc.byKey.get(state.selected), hovered = state.doc.byKey.get(state.hovered), reference = state.doc.byKey.get(state.reference); if(!preferences.stylesOnly) {drawNodeOutline(hovered, canvasChrome.text, [4, 3]); drawNodeOutline(reference, canvasChrome.selection, [5, 3]);} drawNodeOutline(selected, canvasChrome.selection, [], true);
      if(!preferences.stylesOnly) drawMeasurements(selected, hovered && hovered.key !== selected?.key ? hovered : reference); else measurementStatus.hidden=true;
      if (selected?.bounds && state.v.scale > 0.2 && !preferences.stylesOnly) { const p = worldToScreen(state.v, selected.bounds); const localKnown = finite(selected.local?.width) && finite(selected.local?.height), size = localKnown ? selected.local : selected.bounds; const text = `${displayLength(size.width)} × ${displayLength(size.height)} · ${tr(localKnown ? '局部尺寸' : '世界包围盒')}${localKnown && nodePrecision(selected) === 'bounds' ? ' · bounds' : ''}`; ctx.font = '12px system-ui, sans-serif'; const w = ctx.measureText(text).width + 16; ctx.fillStyle = canvasChrome.selection; ctx.fillRect(p.x, p.y + selected.bounds.height * state.v.scale + 6, w, 22); ctx.fillStyle = canvasChrome.ink; ctx.fillText(text, p.x + 8, p.y + selected.bounds.height * state.v.scale + 21); }
    }
    stageMessage.hidden = !(state.loading || state.error || !state.frames.length);
    stageMessageText.textContent = state.error ? `${tr('加载失败')}: ${displayError(state.error)}` : tr(state.loading ? state.frameId ? '正在加载选中版本…' : '正在加载完整目录…' : '暂无画板，请在宿主提供已授权的设计数据。');
    root.dataset.loading = String(state.loading); root.dataset.lowZoom = String(state.v.scale <= 0.2); refreshControls();
  }
  function commonAncestor(first, second) {
    const ancestry = node => { const result = []; let depth = node.depth; for (let i = state.doc.all.indexOf(node) - 1; i >= 0; i--) if (state.doc.all[i].depth < depth) { result.push(state.doc.all[i]); depth = state.doc.all[i].depth; } return result; };
    const other = new Set(ancestry(second).map(node => node.key)); return ancestry(first).find(node => other.has(node.key)) ?? state.doc.frame;
  }
  function drawMeasurements(first, second) {
    measurementStatus.hidden = true; if (!first?.bounds || !second?.bounds || state.v.scale <= 0.2) return;
    const ancestor = commonAncestor(first,second), values = typeof core.measureBetween === 'function' ? core.measureBetween(first,second,{root:state.doc.frame,ancestor}) : spacing(first,second);
    const percentage = (record,key) => record?.state === 'known' && finite(record[key]) ? `${record[key] < 0 ? '重叠 ' : ''}${core.displayValue ? core.displayValue(Math.abs(record[key]),{unit:'px',rounding:preferences.rounding,precision:preferences.precision}).value : Math.abs(record[key])}%` : '未知（无有效分母）';
    const gapLabel = (value,percent = null) => !finite(value) ? '未知' : percent ?? `${value < 0 ? '重叠 ' : ''}${displayLength(Math.abs(value))}`;
    const percent = state.modifiers.ancestor ? values.percentAncestor : state.modifiers.root ? values.percentRoot : null;
    const mode = state.modifiers.ancestor ? `共同祖先百分比：横 ${percentage(values.percentAncestor,'horizontalGap')} · 纵 ${percentage(values.percentAncestor,'verticalGap')}` : state.modifiers.root ? `根百分比：横 ${percentage(values.percentRoot,'horizontalGap')} · 纵 ${percentage(values.percentRoot,'verticalGap')}` : '世界bounds近似（非路径距离）';
    const relation = ({overlap:'重叠',contains:'包含',inside:'内部',separate:'分离'})[values.relation] ?? 'bounds';
    const edges = ['contains','inside'].includes(values.relation) ? ` · 边差 左${displayLength(values.left)} / 右${displayLength(values.right)} / 上${displayLength(values.top)} / 下${displayLength(values.bottom)}` : '';
    measurementStatus.textContent = `水平 ${gapLabel(values.horizontalGap)} · 垂直 ${gapLabel(values.verticalGap)} · ${relation}${edges} · ${mode}${percent ? ' · 世界bounds近似' : ''}`; measurementStatus.hidden = false;
    const a = first.bounds, b = second.bounds;
    const pair = (p,q,text,offset) => { p=worldToScreen(state.v,p); q=worldToScreen(state.v,q); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke(); ctx.fillText(text,(p.x+q.x)/2+offset.x,(p.y+q.y)/2+offset.y); };
    ctx.save(); ctx.strokeStyle = ctx.fillStyle = canvasChrome.measurement; ctx.lineWidth = 1.5; ctx.font = '12px system-ui, sans-serif';
    const ax = a.x+a.width, bx=b.x+b.width, ay=a.y+a.height, by=b.y+b.height;
    const horizontal = ax <= b.x ? [ax,b.x] : bx <= a.x ? [bx,a.x] : [Math.max(a.x,b.x),Math.min(ax,bx)];
    const vertical = ay <= b.y ? [ay,b.y] : by <= a.y ? [by,a.y] : [Math.max(a.y,b.y),Math.min(ay,by)];
    const y = Math.min(ay,by), x=Math.max(a.x,b.x);
    pair({x:horizontal[0],y},{x:horizontal[1],y},gapLabel(values.horizontalGap,percent ? percentage(percent,'horizontalGap') : null),{x:0,y:-10}); pair({x,y:vertical[0]},{x,y:vertical[1]},gapLabel(values.verticalGap,percent ? percentage(percent,'verticalGap') : null),{x:10,y:0}); ctx.restore();
  }
  function imageKey(frame, asset, level, suffix = '') { return JSON.stringify([frame.projectId,frame.designFileId,frame.pageId,frame.frameId,frame.frameId === state.frameId ? state.revisionId : frame.currentRevisionId ?? frame.revisionId ?? frame.latestRevisionId,asset.assetId,level,suffix]); }
  function imageGroup(plan) { return JSON.stringify([plan.identity.frameId,plan.identity.revisionId,plan.asset.assetId,!!plan.target]); }
  function refreshImages() {
    if (state.disposed) return;
    const plans = [], selectedAsset = currentAsset();
    for (const frame of canvasFrames()) {
      const selected = frame.frameId === state.frameId;
      // Never substitute directory/latest preview while a historical revision is loading.
      const asset = selected ? selectedAsset : frame.previewAsset ? descriptorOf(frame.previewAsset) : null;
      if (!asset?.assetId || !frame.bounds || selected && state.loading) continue;
      const bounds = selected ? state.doc?.frame.bounds ?? frame.bounds : frame.bounds, level = previewLevel(Math.max(bounds.width, bounds.height) * state.v.scale * Math.min(2, window.devicePixelRatio || 1));
      const revisionId = selected ? state.revisionId : frame.currentRevisionId ?? frame.revisionId ?? frame.latestRevisionId;
      if (!revisionId || revisionId === 'current') continue;
      const key = imageKey(frame, asset, level), identity = { frameId: frame.frameId, revisionId };
      plans.push({ key, bounds, frame, asset, level, identity, kind: 'preview' });
      if (selected && nativeInput.checked && adapter.getNativeTile && asset.mime === 'image/png' && state.v.scale >= 1) {
        for (const tile of nativeTilePlan(asset, bounds, state.v)) {
          const tileBounds = { x: bounds.x + tile.x * 512 / asset.width * bounds.width, y: bounds.y + tile.y * 512 / asset.height * bounds.height, width: tile.width / asset.width * bounds.width, height: tile.height / asset.height * bounds.height };
          plans.push({ key: imageKey(frame, asset, 'native', `${tile.x},${tile.y}`), bounds: tileBounds, frame, asset, identity, tile, kind: 'native' });
        }
      }
    }
    if (state.propertyTab === 'slices' && state.doc && !slices.hidden) {
      const panelBounds = panel.getBoundingClientRect(), frame = currentFrame();
      for (const target of sliceTargets.values()) {
        const box = target.canvas.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0 || box.bottom < panelBounds.top || box.top > panelBounds.bottom || panelBounds.width <= 0) continue;
        plans.push({ key: imageKey(frame, target.asset, 256, 'slice'), frame, asset: target.asset, level: 256, identity: { frameId: state.frameId, revisionId: state.revisionId }, kind: 'slice-preview', target });
      }
    }
    // Directory thumbnails use the same physical slots, stream/decode budgets and cleanup.
    // No loadAsset fallback: a missing bounded preview is never an original-image GET.
    if (typeof adapter.getPreview === 'function') for (const target of directoryTargets.values()) {
      if (!directoryTargetVisible(target)) continue;
      const frame = target.frame, selected = frame.frameId === state.frameId;
      const asset = selected ? selectedAsset : frame.previewAsset ? descriptorOf(frame.previewAsset) : null;
      const revisionId = selected ? state.revisionId : frame.currentRevisionId ?? frame.revisionId ?? frame.latestRevisionId;
      if (!asset?.assetId || !revisionId || revisionId === 'current' || selected && (state.loading || !state.doc)) continue;
      plans.push({ key: imageKey(frame, asset, 64, 'directory'), frame, asset, level: 64, identity: { frameId: frame.frameId, revisionId }, kind: 'directory-preview', target });
    }
    const previews = plans.filter(plan => plan.kind === 'preview');
    if (previews.length > 1 && previews.reduce((sum,plan) => sum+plan.level*plan.level,0) > LIMITS.pixels/2) for (const plan of previews) if (plan.frame.frameId !== state.frameId) { plan.level = 64; plan.key = imageKey(plan.frame,plan.asset,64); }
    // A low-resolution resident is a real visual fallback, not disposable merely because the target LOD changed.
    const desiredGroups = new Map(plans.filter(plan => plan.kind === 'preview').map(plan => [imageGroup(plan),plan]));
    const fallbacks = new Map();
    for (const previous of [...lowCache.values(),...state.imagePlans.values()]) {
      if (previous.kind !== 'preview' || !scheduler.get(previous.key)) continue;
      const desired = desiredGroups.get(imageGroup(previous)); if (!desired) continue;
      const low = previous.level <= 256;
      if (low) lowCache.set(previous.key,previous);
      if (low || !scheduler.get(desired.key)) fallbacks.set(previous.key,{...previous,bounds:desired.bounds,frame:desired.frame});
    }
    for (const [key,cached] of lowCache) if (!desiredGroups.has(imageGroup(cached)) || !scheduler.get(key)) lowCache.delete(key);
    const combined = new Map([...fallbacks,...plans.map(plan => [plan.key,plan])]);
    const orderedPlans = [...combined.values()].sort((a,b) => (a.kind === 'native' ? 10000 : a.level ?? 0) - (b.kind === 'native' ? 10000 : b.level ?? 0));
    // A rebuilt export canvas still needs a real paint when its bitmap key is already resident.
    const retargetedResident = plans.some(plan => plan.target && state.imagePlans.get(plan.key)?.target?.canvas !== plan.target.canvas && scheduler.get(plan.key)?.bitmap);
    state.imagePlans = new Map(orderedPlans.map(plan => [plan.key,plan]));
    if(retargetedResident)requestRender(); // Paint only, once per changed target; do not refresh or refetch images.
    const protectedKeys = orderedPlans.filter(plan => plan.kind === 'preview' && plan.level <= 256).map(plan => plan.key);
    for (const group of desiredGroups.keys()) { const ready = orderedPlans.find(plan => plan.kind === 'preview' && imageGroup(plan) === group && scheduler.get(plan.key)); if (ready) protectedKeys.push(ready.key); }
    scheduler.protectKeys(protectedKeys);
    scheduler.retainKeys(state.imagePlans.keys());
    const signature = plans.map(p => p.key).join('|');
    if (signature === state.lastImageSignature && !imageRetry) return;
    state.lastImageSignature = signature; imageRetry = false;
    for (const plan of plans) {
      if (scheduler.has(plan.key) || state.imageErrors.has(plan.key)) continue;
      const maxDimension = plan.kind === 'native' ? 512 : plan.level;
      const estimate = { pixels: maxDimension * maxDimension, encoded: maxDimension * maxDimension * 8 + 65536 };
      scheduler.schedule(plan.key, estimate, async context => {
        let descriptor;
        if (plan.kind === 'native') {
          descriptor = descriptorOf(await adapter.getNativeTile(plan.asset.assetId, { ...plan.identity, x: plan.tile.x, y: plan.tile.y, tileSize: 512, signal: context.signal }));
          if (descriptor.width !== plan.tile.width || descriptor.height !== plan.tile.height) throw new Error('原生图块尺寸与可见区计划不符');
        } else if (typeof adapter.getPreview === 'function') {
          descriptor = descriptorOf(await adapter.getPreview(plan.asset.assetId, { ...plan.identity, maxDimension: plan.level, ...(plan.kind === 'slice-preview' ? { variant: 'slice-alpha' } : {}), signal: context.signal }));
          const previewMimeValid = ['image/jpeg','image/png','image/webp','image/gif'].includes(descriptor.mime);
          if (!previewMimeValid || descriptor.width > plan.level || descriptor.height > plan.level) throw new Error('有界LOD衍生物格式/尺寸不符合请求');
        } else {
          if (!finite(plan.asset.width) || !finite(plan.asset.height) || plan.asset.width * plan.asset.height > 16 * 1024 * 1024 || !finite(plan.asset.byteLength) || plan.asset.byteLength > 16 * 1024 * 1024) throw new Error('没有JPEG衍生物；为安全不默认解码整张巨大原图');
          descriptor = descriptorOf(adapter.loadAsset ? await adapter.loadAsset(plan.asset.assetId, { ...plan.identity, signal: context.signal }) : plan.asset);
        }
        if (!context.current()) throw abortError();
        if (descriptor.frameId != null && String(descriptor.frameId) !== plan.identity.frameId || descriptor.revisionId != null && String(descriptor.revisionId) !== plan.identity.revisionId) throw new Error('图像身份不符；拒绝混入其他版本');
        imageEstimate(descriptor.width, descriptor.height, descriptor.byteLength);
        return decodeDescriptor(descriptor, context, { baseURL });
      }, { kind: plan.kind, generation: state.imageGeneration }).then(() => { if (!state.disposed) { requestRender(true); if (!state.imageErrors.size && !state.error) say(preferences.language==='en' ? 'Preview loaded' : '预览已加载'); } }, error => {
        if (state.disposed) return;
        if (error.name === 'AbortError') { if (state.imagePlans.has(plan.key)) { state.lastImageSignature = ''; requestRender(true); } return; }
        state.imageErrors.set(plan.key, errorText(error)); if (plan.target) { plan.target.status.textContent = tr('缩略图不可用'); plan.target.status.title = plan.target.status.textContent; plan.target.status.dataset.state = 'error'; } say(displayError(errorText(error)), true); requestRender();
      });
    }
  }
  function resize() {
    if (state.disposed) return; const size = stage.getBoundingClientRect(), width = Math.max(1, size.width), height = Math.max(1, size.height), dpr = Math.min(2, window.devicePixelRatio || 1);
    state.v = resizeViewport(state.v, width, height); canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
    if (state.fitPending) fitView(); syncPanelSemantics(); requestRender(true);
  }
  const pointers = new Map(); let drag = null, spacePressed = false;
  function cancelGesture() { const ids = [...pointers.keys()]; pointers.clear(); drag = null; spacePressed = false; for (const id of ids) { try { canvas.releasePointerCapture?.(id); } catch {} } state.modifiers = {root:false,ancestor:false}; state.hovered = null; state.hoveredFrameId = null; requestRender(); }
  function updateModifiers(event) { state.modifiers = {root:!!(event.ctrlKey || event.metaKey),ancestor:!!event.altKey}; }
  const localPoint = event => { const b = canvas.getBoundingClientRect(); return { x: event.clientX - b.left, y: event.clientY - b.top }; };
  const twoPoint = values => { const [a, b] = values; return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) }; };
  canvas.addEventListener('pointerdown', event => { if (event.button !== 0 && event.button !== 1) return; const p = localPoint(event); pointers.set(event.pointerId, p); canvas.setPointerCapture(event.pointerId); drag = { start: p, last: p, moved: false, shift: event.shiftKey, panOnly: event.button === 1 || spacePressed }; updateModifiers(event); if (drag.panOnly) event.preventDefault(); canvas.focus({ preventScroll: true }); });
  canvas.addEventListener('pointermove', event => {
    const oldModifiers = JSON.stringify(state.modifiers); updateModifiers(event); if (oldModifiers !== JSON.stringify(state.modifiers)) requestRender();
    const p = localPoint(event);
    if (!pointers.has(event.pointerId)) { const world = screenToWorld(state.v, p), hit = state.doc ? scopedHit(world) : null, frame = hit ? null : metadataHit(world); const key = hit?.node.key ?? null, frameId = frame?.frameId ?? null; if (state.hovered !== key || state.hoveredFrameId !== frameId) { state.hovered = key; state.hoveredFrameId = frameId; state.lastPrecision = hit?.precision ?? (frame ? 'metadata-bounds' : null); requestRender(); } return; }
    const old = [...pointers.values()]; pointers.set(event.pointerId, p); const next = [...pointers.values()];
    if (next.length >= 2 && old.length >= 2) { const a = twoPoint(old), b = twoPoint(next); if (a.distance > 0) state.v = zoomAt(state.v, a.center, b.distance / a.distance); state.v = pan(state.v, b.center.x - a.center.x, b.center.y - a.center.y); if (drag) drag.moved = true; }
    else if (drag) { if (drag.panOnly || Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 5) drag.moved = true; if (drag.moved) state.v = pan(state.v, p.x - drag.last.x, p.y - drag.last.y); drag.last = p; }
    refreshControls(); requestRender(true);
  });
  function pointerEnd(event) {
    const p = localPoint(event), tapped = pointers.size === 1 && drag && !drag.moved && !drag.panOnly && event.type !== 'pointercancel'; pointers.delete(event.pointerId);
    if (tapped) {
      const world = screenToWorld(state.v, p), hit = state.doc ? scopedHit(world) : null;
      if (hit) { state.lastPrecision = hit.precision; chooseNode(hit.node, event.shiftKey); }
      else { const frame = metadataHit(world); if (frame) selectFrame(frame.frameId); }
    }
    if (!pointers.size) drag = null; else { const remaining = [...pointers.values()][0]; drag = { start: remaining, last: remaining, moved: true }; }
  }
  canvas.addEventListener('pointerup', pointerEnd); canvas.addEventListener('pointercancel', cancelGesture); canvas.addEventListener('lostpointercapture', event => { if (pointers.has(event.pointerId)) cancelGesture(); });
  canvas.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  window.addEventListener('blur', cancelGesture);
  canvas.addEventListener('pointerleave', () => { if (!pointers.size) { state.hovered = null; state.hoveredFrameId = null; requestRender(); } });
  canvas.addEventListener('wheel', event => { event.preventDefault(); changeZoom(Math.exp(-Math.max(-600, Math.min(600, event.deltaY)) * 0.0015), localPoint(event)); }, { passive: false });
  canvas.addEventListener('keydown', event => {
    updateModifiers(event); requestRender(); if (event.key === ' ' || event.code === 'Space') { event.preventDefault(); spacePressed = true; return; }
    const amount = event.shiftKey ? 100 : 20;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); state.v = pan(state.v, event.key === 'ArrowLeft' ? amount : event.key === 'ArrowRight' ? -amount : 0, event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0); requestRender(true); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25); }
    else if (event.key === '-') { event.preventDefault(); changeZoom(0.8); }
    else if (event.key.toLowerCase() === 'f' || event.key === '0') { event.preventDefault(); fitView(); }
    else if (event.key === '1') { event.preventDefault(); fitView(1); }
    else if (event.key === 'Enter' && state.doc) { event.preventDefault(); const hit = scopedHit(screenToWorld(state.v, { x: state.v.width / 2, y: state.v.height / 2 })); if (hit) chooseNode(hit.node, event.shiftKey); }
    else if (event.key === 'Escape') { state.hovered = null; state.reference = null; togglePanel(null); renderProperties(); requestRender(); }
  });
  canvas.addEventListener('keyup', event => { if (event.key === ' ' || event.code === 'Space') spacePressed = false; updateModifiers(event); requestRender(); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); const openMenu = [settings,stageAdvanced].find(node => node?.open); if (openMenu && !state.activePanel) { openMenu.open = false; openMenu.children[0]?.focus?.(); } else togglePanel(null); return; }
    if (event.key !== 'Tab' || !state.activePanel || !panelIsNarrow()) return;
    const active = state.activePanel === 'directory' ? sidebar : panel;
    const focusables = [...active.querySelectorAll('button'),...active.querySelectorAll('input'),...active.querySelectorAll('select'),...active.querySelectorAll('summary'),...active.querySelectorAll('a')].filter(node => !node.disabled && !node.hidden && !node.inert && node.getBoundingClientRect().width > 0);
    // Use native DOM order rather than control-type order when the browser exposes compareDocumentPosition.
    focusables.sort((a,b) => a.compareDocumentPosition ? a.compareDocumentPosition(b) & 2 ? 1 : -1 : 0);
    const first = focusables[0], last = focusables.at(-1); if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !active.contains?.(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !active.contains?.(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
  panel.addEventListener('scroll', () => requestRender(true), { passive: true });
  frameList.addEventListener('scroll', () => requestRender(true), { passive: true });
  search.addEventListener('input', renderDirectory); revisionSelect.addEventListener('change', () => selectRevision(revisionSelect.value)); nativeInput.addEventListener('change', () => requestRender(true)); sliceScope.addEventListener('change', () => { if(sliceScope.value==='node')updatePropertyContext(false);else setPropertyTab('slices');renderSlices();requestRender(true); });
  function refreshLocale() {
    root.setAttribute('lang',preferences.language);
    for(const [node,values] of bindings) {if(root.contains && !root.contains(node)&&!cssDisclosure.contains?.(node)) {bindings.delete(node);continue;} for(const [attribute,key] of values) if(attribute) node.setAttribute(attribute,tr(key)); else node.textContent=tr(key);}
  }
  for (const input of Object.values(preferenceInputs)) input.addEventListener('change', () => {
    preferences = validPreferences({...preferences,...Object.fromEntries(Object.entries(preferenceInputs).map(([key,control]) => [key,control.type==='checkbox'?control.checked:control.value])),rpxBaseExplicit:preferences.rpxBaseExplicit||input===preferenceInputs.rpxBase});
    for (const [key,control] of Object.entries(preferenceInputs)) if(control.type==='checkbox') control.checked=preferences[key]; else control.value=preferences[key]==null?'':String(preferences[key]);
    try { window.localStorage?.setItem(PREF_KEY,JSON.stringify(preferences)); } catch { say(preferences.language==='en'?'Preferences cannot be saved in this environment.':'当前环境禁止保存显示偏好；本次仍可使用'); }
    if(state.doc) {const selected=state.doc.byKey.get(state.selected);if(selected) state.selected=scopedNode(selected).key;const hovered=state.doc.byKey.get(state.hovered);if(hovered)state.hovered=scopedNode(hovered).key;}
    refreshLocale(); renderDirectory(); renderRevisions(); renderTree(); renderProperties(); updatePropertyContext(false); renderSlices(); refreshControls(); requestRender(true);
  });
  async function resolveLocation() {
    if (typeof adapter.resolveLocation === 'function') return adapter.resolveLocation();
    if (!window.location) return null; const url = safeNavigationURL(window.location.href), match = url.pathname.match(/^\/viewer\/r\/([^/]+)\/?$/);
    if (!match) return null; return {frameId:decodeURIComponent(match[1]),revisionId:url.searchParams.get('revision'),mode:'frame'};
  }
  async function navigate(target, {replace = false,fromLocation = false} = {}) {
    if (!target || !safeID(String(target.frameId ?? '')) || target.revisionId != null && !safeID(String(target.revisionId))) throw new TypeError('无效导航身份');
    if (!state.frames.some(frame => frame.frameId === String(target.frameId))) throw new Error('位置画板不在授权目录内；未猜测替代');
    if (String(target.frameId) === state.frameId && state.doc && target.revisionId && target.revisionId !== 'current') return selectRevision(String(target.revisionId),{replace,fromLocation});
    return selectFrame(String(target.frameId),target.revisionId ?? null,{replace,fromLocation});
  }
  const onPopState = async () => { const request = locationRequest.begin(); try { const target = await resolveLocation(); if (target && request.current() && !state.disposed) await navigate(target,{fromLocation:true}); } catch (error) { if (request.current() && !state.disposed) loadFailed(error); } };
  window.addEventListener('popstate',onPopState);
  if (window.ResizeObserver) { resizeObserver = new window.ResizeObserver(resize); resizeObserver.observe(stage); } else window.addEventListener('resize', resize);
  setDirectoryTab('frames'); setPropertyTab('details'); refreshLocale(); refreshControls(); resize(); renderDownload(download.diagnostics);
  const ready = (async () => {
    const request = directoryRequest.begin();
    try {
      const result = await adapter.listFrames({ signal: request.signal }); if (!request.current() || state.disposed) return;
      const rawFrames = Array.isArray(result) ? result : result.frames, frames = normalizeDirectory(rawFrames).map(frame => ({...rawFrames.find(raw => String(raw.frameId ?? raw.id) === frame.frameId),...frame}));
      state.context = result?.context ?? adapter.context ?? {}; state.frames = frames; state.groups = Array.isArray(result?.groups) ? result.groups : []; directoryGroupsInitialized = false; lastDirectoryFrameId = null; state.loading = false; renderDirectory();
      if (!frames.length) { renderSnapshot(); say('完整目录为空'); requestRender(true); return; }
      const locationTarget = initialFrameId == null && initialRevisionId == null ? await resolveLocation() : null; if (!request.current() || state.disposed) return;
      const wantedFrame = initialFrameId ?? locationTarget?.frameId, wantedRevision = initialRevisionId ?? locationTarget?.revisionId;
      const selected = wantedFrame == null ? frames[0] : frames.find(frame => frame.frameId === String(wantedFrame));
      if (!selected) throw new Error('指定平台画板ID不存在；未按同名合并或猜测替代');
      await selectFrame(selected.frameId, wantedRevision, {replace:true}); fitView();
    } catch (error) { if (request.current() && !state.disposed) loadFailed(error); }
  })();
  return {
    ready, navigate,
    get diagnostics() { return { contractSHA: CONTRACT_SHA, frameCount: state.frames.length, loadedTrees: state.doc ? 1 : 0, loadedLayerCount: state.doc?.all.length ?? 0, renderedStageFrames: state.renderedFrames.length, renderedStageFramesMeaning: 'interactive-index-only', interactionStageFrames: state.renderedFrames.length, visibleMetadataFrames: state.paintFrames.length, canvasPaintedFrameBounds: state.paintFrames.length, canvasPaintedImageFrames: state.paintedImageFrames, canvasImageDrawCalls: state.imageDrawCalls, imagePlanCount: state.imagePlans.size, previewImagePlanFrames: [...state.imagePlans.values()].filter(p => p.kind === 'preview').length, nativeImagePlanCount: [...state.imagePlans.values()].filter(p => p.kind === 'native').length, hoveredFrameId: state.hoveredFrameId, identity: state.doc?.identity ?? null, loading: state.loading, error: state.error, imageErrors: [...state.imageErrors.values()], scheduler: scheduler.diagnostics, download: download.diagnostics, viewport: { ...state.v }, nativeOptIn: nativeInput.checked, nativeDetailEnabled: nativeInput.checked, nativeActive: [...state.imagePlans.values()].some(p => p.kind === 'native' && scheduler.get(p.key)), lowLODCacheEntries: lowCache.size, nativeTriggerScale: 1, geometryPrecision: state.lastPrecision, selectedNodeId:state.doc?.byKey.get(state.selected)?.figmaNodeId??null, sliceScope:sliceScope.value, selectedExportId:state.selectedExportId??null, renderedSliceIds:[...sliceList.children].filter(node=>node.dataset.sliceId!=null).map(node=>node.dataset.sliceId), hoveredNodeId:state.doc?.byKey.get(state.hovered)?.figmaNodeId??null, inspection:{inspectComponents:preferences.inspectComponents,inspectExports:preferences.inspectExports,stylesOnly:preferences.stylesOnly}, language:preferences.language, rpxBase:preferences.rpxBase, cssGenerationWarnings:[...(state.cssGenerationWarnings??[])], source: 'behavior-contract-only-independent-implementation', disposed: state.disposed }; },
    dispose() { if (state.disposed) return; state.disposed = true; loadRequest.cancel(); directoryRequest.cancel(); locationRequest.cancel(); clearDirectoryThumbnails(); scheduler.dispose(); download.dispose(); resizeObserver?.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('popstate', onPopState); window.removeEventListener('blur', cancelGesture); if (raf) window.cancelAnimationFrame(raf); pointers.clear(); root.remove(); },
  };
}
export { CONTRACT_SHA, LIMITS };
