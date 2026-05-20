/* global app, File, Folder, DocumentColorSpace, TracingModeType, TracingPaletteType, ExportType, PDFSaveOptions, IllustratorSaveOptions, ExportOptionsSVG, ExportOptionsPNG24 */

// Illustrator Image Trace helper for small logo PNGs.
// Run through Illustrator.Application.DoJavaScriptFile from PowerShell.

var SRC = "C:/Users/micke/Downloads/tax-advocate-group-logo-small.png";
var OUT_DIR = "C:/Users/micke/Downloads/tag-logo-wall-vector";
var LOG = OUT_DIR + "/illustrator-trace-log.txt";

function log(message) {
  var f = new File(LOG);
  f.open("a");
  f.writeln(new Date().toUTCString() + " " + message);
  f.close();
}

function ensureFolder(path) {
  var folder = new Folder(path);
  if (!folder.exists) folder.create();
  return folder;
}

function fitPlacedItem(item, artWidth, artHeight, margin) {
  var maxWidth = artWidth - margin * 2;
  var maxHeight = artHeight - margin * 2;
  var ratio = Math.min(maxWidth / item.width, maxHeight / item.height);
  item.width = item.width * ratio;
  item.height = item.height * ratio;
  item.position = [
    (artWidth - item.width) / 2 - 36,
    artHeight - ((artHeight - item.height) / 2),
  ];
}

function tryPreset(tracing, presetName) {
  try {
    tracing.tracingOptions.loadFromPreset(presetName);
    log("loaded trace preset: " + presetName);
    return true;
  } catch (e) {
    log("trace preset unavailable: " + presetName + " / " + e);
    return false;
  }
}

function configureTrace(tracing) {
  var options = tracing.tracingOptions;
  if (!tryPreset(tracing, "16 Colors")) {
    tryPreset(tracing, "High Fidelity Photo");
  }

  try { options.tracingMode = TracingModeType.TRACINGMODECOLOR; } catch (e1) {}
  try { options.tracingPalette = TracingPaletteType.TRACINGPALETTEFULLTONE; } catch (e2) {}
  try { options.palette = TracingPaletteType.TRACINGPALETTEFULLTONE; } catch (e3) {}
  try { options.maxColors = 24; } catch (e4) {}
  try { options.pathFitting = 0.7; } catch (e5) {}
  try { options.cornerAngle = 0; } catch (e6) {}
  try { options.ignoreWhite = true; } catch (e7) {}
  try { options.noiseFidelity = 1; } catch (e8) {}
}

function saveOutputs(doc, outDir) {
  var aiFile = new File(outDir + "/tax-advocate-group-logo-wall-vector.ai");
  var pdfFile = new File(outDir + "/tax-advocate-group-logo-wall-vector.pdf");
  var svgFile = new File(outDir + "/tax-advocate-group-logo-wall-vector.svg");
  var pngFile = new File(outDir + "/tax-advocate-group-logo-wall-proof-7200px.png");

  var aiOptions = new IllustratorSaveOptions();
  doc.saveAs(aiFile, aiOptions);
  log("saved AI: " + aiFile.fsName);

  var pdfOptions = new PDFSaveOptions();
  pdfOptions.preserveEditability = true;
  doc.saveAs(pdfFile, pdfOptions);
  log("saved PDF: " + pdfFile.fsName);

  var svgOptions = new ExportOptionsSVG();
  doc.exportFile(svgFile, ExportType.SVG, svgOptions);
  log("saved SVG: " + svgFile.fsName);

  var pngOptions = new ExportOptionsPNG24();
  pngOptions.antiAliasing = true;
  pngOptions.transparency = true;
  pngOptions.artBoardClipping = true;
  // 24 in * 300 ppi = 7200 px. Illustrator export scale is percent of 72 ppi.
  pngOptions.horizontalScale = 416.6667;
  pngOptions.verticalScale = 416.6667;
  doc.exportFile(pngFile, ExportType.PNG24, pngOptions);
  log("saved PNG proof: " + pngFile.fsName);
}

function main() {
  ensureFolder(OUT_DIR);
  var oldLog = new File(LOG);
  if (oldLog.exists) oldLog.remove();
  log("starting");

  var source = new File(SRC);
  if (!source.exists) throw new Error("Source PNG not found: " + SRC);

  // Slightly wider than 24x24 so the right leaf has production safe area.
  // The PNG source is very tight on the right edge, so this master is
  // intended to be trimmed/centered by the sign shop rather than clipped.
  var artWidth = 26 * 72;
  var artHeight = 24 * 72;
  var doc = app.documents.add(DocumentColorSpace.RGB, artWidth, artHeight);
  doc.artboards[0].artboardRect = [0, artHeight, artWidth, 0];
  doc.rasterEffectSettings.resolution = 300;

  var placed = doc.placedItems.add();
  placed.file = source;
  fitPlacedItem(placed, artWidth, artHeight, 108);
  placed.selected = true;

  log("placed source: " + placed.width + " x " + placed.height);
  var tracedItem = placed.trace();
  configureTrace(tracedItem.tracing);
  app.redraw();
  tracedItem.tracing.expandTracing();
  log("expanded tracing");

  saveOutputs(doc, OUT_DIR);
  doc.close();
  log("done");
}

main();
