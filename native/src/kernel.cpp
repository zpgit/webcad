#include "kernel.hpp"

#include <algorithm>
#include <cmath>
#include <exception>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BinTools.hxx>
#include <BinTools_FormatVersion.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_InterfaceModel.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_Printer.hxx>
#include <NCollection_DataMap.hxx>
#include <NCollection_Sequence.hxx>
#include <Poly_Triangulation.hxx>
#include <Quantity_Color.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_StepModelType.hxx>
#include <STEPControl_Writer.hxx>
#include <ShapeProcess.hxx>
#include <Standard_Failure.hxx>
#include <Standard_Type.hxx>
#include <Standard_Version.hxx>
#include <StepBasic_Product.hxx>
#include <StepData_StepModel.hxx>
#include <StepDimTol_GeometricTolerance.hxx>
#include <StepRepr_MaterialDesignation.hxx>
#include <StepRepr_NextAssemblyUsageOccurrence.hxx>
#include <StepShape_DimensionalSize.hxx>
#include <StepVisual_PresentationLayerAssignment.hxx>
#include <StepVisual_StyledItem.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Label.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_ColorType.hxx>
#include <XCAFDoc_GraphNode.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>

#include <emscripten/heap.h>

#include "registry.hpp"

namespace webcad {
namespace {

// Peak WASM linear memory observed this session. Sampled after each operation
// rather than continuously - enough to report a session peak without
// instrumenting the allocator.
double g_peakMemoryBytes = 0.0;

// The single staging buffer for byte payloads crossing the boundary, in either
// direction. One at a time is deliberate: a document is checkpointed as a
// whole, so there is never a second payload in flight, and a single buffer
// makes "who owns these bytes" answerable at a glance.
std::string g_staging;

double currentMemoryBytes() {
  return static_cast<double>(emscripten_get_heap_size());
}

void sampleMemory() {
  g_peakMemoryBytes = std::max(g_peakMemoryBytes, currentMemoryBytes());
}

// Wraps an operation so no exception escapes into the WASM trap handler.
// An uncaught C++ exception at the boundary can leave the module unusable,
// which would break the guarantee that the kernel survives a failed operation.
template <typename R, typename F>
R guarded(F&& fn) {
  try {
    R out = fn();
    sampleMemory();
    return out;
  } catch (const Standard_Failure& e) {
    // Standard_Failure derives from std::runtime_error in OCCT 8.x; what() is
    // the supported accessor (GetMessageString is deprecated).
    R out;
    const char* msg = e.what();
    out.status = static_cast<int32_t>(Status::KernelOperationFailed);
    out.message = std::string("OCCT: ") + (msg && *msg ? msg : "unspecified failure");
    sampleMemory();
    return out;
  } catch (const std::exception& e) {
    R out;
    out.status = static_cast<int32_t>(Status::KernelOperationFailed);
    out.message = std::string("std::exception: ") + e.what();
    sampleMemory();
    return out;
  } catch (...) {
    R out;
    out.status = static_cast<int32_t>(Status::KernelOperationFailed);
    out.message = "unknown native exception";
    sampleMemory();
    return out;
  }
}

template <typename R>
R fail(Status s, std::string message) {
  R out;
  out.status = static_cast<int32_t>(s);
  out.message = std::move(message);
  return out;
}

// Counts DISTINCT sub-shapes.
//
// TopExp_Explorer would visit a shared entity once per parent - a box reports 24
// edges and 48 vertices that way, because each edge is walked from both adjacent
// faces. Mapping into an indexed map deduplicates, giving the 12 edges and 8
// vertices a box actually has.
uint32_t countSubShapes(const TopoDS_Shape& shape, TopAbs_ShapeEnum type) {
  TopTools_IndexedMapOfShape unique;
  TopExp::MapShapes(shape, type, unique);
  return static_cast<uint32_t>(unique.Extent());
}

// A primitive or Boolean result must be a valid closed solid before a handle is
// issued, so a malformed shape never becomes reachable by a handle.
bool isValidSolid(const TopoDS_Shape& shape) {
  if (shape.IsNull()) return false;
  if (countSubShapes(shape, TopAbs_SOLID) == 0) return false;
  return BRepCheck_Analyzer(shape).IsValid() ;
}

OpResult registerSolid(const TopoDS_Shape& shape, const char* what) {
  if (shape.IsNull()) {
    return fail<OpResult>(Status::KernelOperationFailed,
                          std::string(what) + " produced a null shape");
  }
  const uint32_t solids = countSubShapes(shape, TopAbs_SOLID);
  if (solids == 0) {
    // No solid is a legitimate outcome for a Boolean, reported as EmptyResult
    // by the caller. For a primitive it is a failure. Distinguishing the two is
    // the caller's job; here we only refuse to issue a handle.
    return fail<OpResult>(Status::EmptyResult,
                          std::string(what) + " produced no solid");
  }
  if (!BRepCheck_Analyzer(shape).IsValid()) {
    return fail<OpResult>(Status::KernelOperationFailed,
                          std::string(what) + " produced an invalid solid");
  }

  OpResult out;
  out.bodyId = registry().add(shape);
  out.solidCount = solids;
  return out;
}

// Validates a rotation/extrusion axis is not degenerate.
bool axisIsUsable(double x, double y, double z) {
  return std::sqrt(x * x + y * y + z * z) > 1e-12;
}

// --- STEP translation helpers ----------------------------------------------

// Registers a shape that came from outside this system.
//
// Deliberately weaker than registerSolid, which stays the strict gate for
// primitives and Boolean results: those are geometry this kernel just built, and
// a malformed one is a bug worth refusing. An imported shape is different -
// real STEP data contains open shells and solids that fail BRepCheck, and
// refusing them would reject usable files wholesale and report nothing about
// them. So the shape is registered and its validity is reported honestly,
// leaving an operation that needs a solid to fail on its own terms.
//
// The one thing still refused is a shape with no face at all: a stray curve or
// point carries nothing this system can treat as a body, and counting it as
// unregistered says more than issuing a handle to it would.
bool importedShapeIsUsable(const TopoDS_Shape& shape) {
  if (shape.IsNull()) return false;
  return countSubShapes(shape, TopAbs_FACE) > 0;
}

// Flattens compounds down to their non-compound leaves.
//
// A STEP assembly transfers as nested compounds. This stage has nowhere to put
// an assembly hierarchy - that needs XCAF and is MVP-3's - so the parts arrive
// as a flat set of bodies rather than one body that is secretly a tree. The
// recursion is what makes "flattened" true for a nested assembly and not just
// for a single level of it.
void collectLeafShapes(const TopoDS_Shape& shape,
                       std::vector<TopoDS_Shape>& out) {
  if (shape.IsNull()) return;
  if (shape.ShapeType() != TopAbs_COMPOUND) {
    out.push_back(shape);
    return;
  }
  for (TopoDS_Iterator it(shape); it.More(); it.Next()) {
    collectLeafShapes(it.Value(), out);
  }
}

// --- XCAF structure helpers -------------------------------------------------

// The scratch XCAF document, closed on every path out of a translation.
//
// XCAFApp_Application is a process-wide singleton holding a list of open
// documents, so a translation that returns without closing leaves the whole
// document - labels, attributes, and every shape it transferred - alive for the
// life of the module. Import is the one operation a user repeats with large
// files, so that is a leak that compounds exactly where memory is already the
// constraint.
//
// A destructor rather than a call at each exit, because there are several ways
// out of a structured import and only one of them is the happy path. Nothing
// here is copyable and nothing hands the handle out beyond the call: the
// design's rule is that no TDF_Label outlives translation, and a document that
// cannot escape is how that is enforced rather than remembered.
class ScratchDocument {
 public:
  ScratchDocument() {
    app_ = XCAFApp_Application::GetApplication();
    // BinXCAF names the format's persistence driver. Nothing is ever persisted
    // through it - the native document is the container - but a document has to
    // declare a format to be created at all.
    app_->NewDocument("BinXCAF", doc_);
  }

  ~ScratchDocument() {
    // A destructor must not throw: this one can run while an OCCT exception is
    // already propagating out of the translation, and letting a second escape
    // here would take the module down instead of reporting a failure.
    try {
      close();
    } catch (...) {
    }
  }

  ScratchDocument(const ScratchDocument&) = delete;
  ScratchDocument& operator=(const ScratchDocument&) = delete;

  void close() {
    if (doc_.IsNull()) return;
    occ::handle<TDocStd_Document> doc = doc_;
    doc_.Nullify();
    app_->Close(doc);
  }

  bool isNull() const { return doc_.IsNull(); }
  const occ::handle<TDocStd_Document>& get() const { return doc_; }

 private:
  occ::handle<TDocStd_Application> app_;
  occ::handle<TDocStd_Document> doc_;
};

// A label's path, as a map key.
//
// Used instead of hashing TDF_Label itself: the entry string is stable, is what
// OCCT's own diagnostics print, and does not depend on which hasher template a
// given OCCT release expects. At assembly sizes the cost is irrelevant, and a
// key that can be printed is worth more here than one that is fast.
std::string labelEntry(const TDF_Label& label) {
  TCollection_AsciiString entry;
  TDF_Tool::Entry(label, entry);
  return std::string(entry.ToCString());
}

// A label's name, as UTF-8, empty when it has none.
//
// UTF-8 rather than TCollection_AsciiString, which substitutes a placeholder
// for every non-ASCII character. A name is foreign text that gets displayed and
// never matched, so mangling it would be a loss with nothing bought - and files
// from outside an English-speaking toolchain routinely carry names this would
// destroy.
std::string labelName(const TDF_Label& label) {
  occ::handle<TDataStd_Name> attribute;
  if (!label.FindAttribute(TDataStd_Name::GetID(), attribute)) return {};
  const TCollection_ExtendedString& text = attribute->Get();
  if (text.Length() == 0) return {};

  std::vector<char> buffer(static_cast<size_t>(text.LengthOfCString()) + 1, '\0');
  Standard_PCharacter cursor = buffer.data();
  text.ToUTF8CString(cursor);
  return std::string(buffer.data());
}

// A shape-to-colour map, for reading subshape colours in one pass.
using ColourByShape =
    NCollection_DataMap<TopoDS_Shape, Quantity_Color, TopTools_ShapeMapHasher>;

// A label's own colour, if it has one.
//
// Surface first, then the generic assignment. XCAF splits a shape's colour
// across three types - surface, curve, generic - and only the first two are
// about a solid's appearance; curve colour describes wireframe presentation
// this system does not render. Generic is the fallback a writer uses when it
// does not distinguish, so it is consulted second rather than ignored.
bool labelColour(const TDF_Label& label, Quantity_Color& out) {
  if (XCAFDoc_ColorTool::GetColor(label, XCAFDoc_ColorSurf, out)) return true;
  if (XCAFDoc_ColorTool::GetColor(label, XCAFDoc_ColorGen, out)) return true;
  return false;
}

// An occurrence's OWN colour, if the file gave it one.
//
// Deliberately not XCAFDoc_ColorTool::GetInstanceColor, which is a RESOLVING
// accessor: where it finds no override it falls back to the component label,
// and then to the referenced part's own colour. That answers "what should this
// occurrence display as", which is a question the document layer asks later
// and with its own resolution order. Asked here it reports every occurrence of
// a coloured part as carrying an override - measured, not feared: both
// occurrences of the blue bracket came back blue, and the distinction the two
// colour fields exist to preserve was gone.
//
// So this is the first half of GetInstanceColor without the fallbacks: find
// the component's label chain, find the SHUO hung off it, and read the colour
// from the SHUO's own label. Absent means absent.
bool occurrenceOverride(const occ::handle<XCAFDoc_ColorTool>& colourTool,
                        const TDF_Label& occurrence,
                        Quantity_Color& out) {
  if (colourTool.IsNull()) return false;
  const occ::handle<XCAFDoc_ShapeTool> shapeTool = colourTool->ShapeTool();
  if (shapeTool.IsNull()) return false;

  const TopoDS_Shape located = XCAFDoc_ShapeTool::GetShape(occurrence);
  if (located.IsNull()) return false;

  NCollection_Sequence<TDF_Label> chain;
  if (!shapeTool->FindComponent(located, chain)) return false;

  // Walk up the usage chain: an override can be attached at any level above
  // the component, and the deepest one wins. Same traversal OCCT's own
  // accessor makes, stopping where it would start guessing.
  while (chain.Length() > 1) {
    occ::handle<XCAFDoc_GraphNode> shuo;
    if (XCAFDoc_ShapeTool::FindSHUO(chain, shuo) && !shuo.IsNull()) {
      if (labelColour(shuo->Label(), out)) return true;
    }
    chain.Remove(chain.Length());
  }
  return false;
}

// Writes a colour out as sRGB in 0..1.
//
// Not Red()/Green()/Blue(), which return OCCT's internal LINEAR components. A
// STEP COLOUR_RGB is decoded as sRGB (STEPConstruct_Styles::DecodeColor) and
// stored converted, so a file saying 0.2 comes back as 0.033 through the
// component accessors. Everything downstream - the document, the renderer, and
// a re-export, which encodes as sRGB again - wants the number the file meant.
void writeColour(const Quantity_Color& colour, double& r, double& g, double& b) {
  colour.Values(r, g, b, Quantity_TOC_sRGB);
}

// Every coloured subshape of a part, gathered once.
//
// One pass over the part's subshape labels rather than a lookup per face: the
// shape-keyed overload of GetColor searches for a label each time it is called,
// which turns reading a thousand faces into a thousand searches.
ColourByShape subShapeColours(const TDF_Label& definition) {
  ColourByShape out;
  NCollection_Sequence<TDF_Label> subLabels;
  XCAFDoc_ShapeTool::GetSubShapes(definition, subLabels);
  for (int i = 1; i <= subLabels.Length(); ++i) {
    const TDF_Label sub = subLabels.Value(i);
    Quantity_Color colour;
    if (!labelColour(sub, colour)) continue;
    const TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(sub);
    if (shape.IsNull()) continue;
    out.Bind(shape, colour);
  }
  return out;
}

// Fills in a part's name, colour, face count, and face-colour block.
//
// The face walk uses the same TopExp_Explorer call the mesher uses, on the same
// registered shape, which is what makes "the Nth colour belongs to the Nth
// range" true rather than hoped for. Task 1.2 measured that this order survives
// a checkpoint; this is the other half of the pairing.
void readPartAppearance(const TDF_Label& definition,
                        const TopoDS_Shape& shape,
                        StepPart& part,
                        std::vector<StepFaceColour>& faceColours) {
  const ColourByShape subColours = subShapeColours(definition);

  // A shape-level colour comes from the label when the label IS this shape,
  // and from the subshape map when the shape is one leaf of a compound the
  // label named. Both routes exist in real files and neither is the odd one.
  Quantity_Color colour;
  bool has = false;
  if (XCAFDoc_ShapeTool::GetShape(definition).IsSame(shape)) {
    has = labelColour(definition, colour);
  }
  if (!has && subColours.IsBound(shape)) {
    colour = subColours.Find(shape);
    has = true;
  }
  if (has) {
    part.hasColour = true;
    writeColour(colour, part.colourR, part.colourG, part.colourB);
  }

  // Counted in one pass, and the block is only emitted if the pass found
  // something - so a part with no face colour costs nothing beyond its count.
  std::vector<StepFaceColour> block;
  uint32_t faces = 0;
  uint32_t coloured = 0;
  for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
    ++faces;
    StepFaceColour entry;
    if (subColours.IsBound(exp.Current())) {
      entry.has = true;
      writeColour(subColours.Find(exp.Current()), entry.r, entry.g, entry.b);
      ++coloured;
    }
    block.push_back(entry);
  }

  part.faceCount = faces;
  part.colouredFaceCount = coloured;
  if (coloured > 0) {
    part.faceColourStart = static_cast<uint32_t>(faceColours.size());
    faceColours.insert(faceColours.end(), block.begin(), block.end());
  }
}

// Appends a location as 12 doubles, row-major 3x4.
//
// gp_Trsf is exactly a 3x4 affine with a scale folded in, so these twelve carry
// it losslessly - including the mirrored and scaled forms that a decomposition
// into translation and quaternion could not represent. Nothing here decomposes
// it, and nothing downstream is expected to.
void appendPlacement(const TopLoc_Location& location, std::vector<double>& out) {
  const gp_Trsf transform = location.Transformation();
  for (int row = 1; row <= 3; ++row) {
    for (int column = 1; column <= 4; ++column) {
      out.push_back(transform.Value(row, column));
    }
  }
}

// State for one structured walk.
struct StructureWalk {
  StepImportResult* out = nullptr;

  // Held because an occurrence override is not reachable from a label: see
  // walkOccurrence. The part-level and face-level reads need no tool at all,
  // which is why this is the only member that is one.
  occ::handle<XCAFDoc_ColorTool> colourTool;

  // Part shapes in first-encounter order. This order IS the body order, and
  // therefore the meaning of StepInstance::part.
  std::vector<TopoDS_Shape> partShapes;

  // Part label entry to part index, or -1 for a label whose shape this system
  // cannot hold. Memoized so a part referenced by twenty components is
  // registered once - keyed on the label, which is the definition, rather than
  // on the located shape an occurrence produces, which differs per occurrence
  // and would defeat the whole point of instancing.
  std::map<std::string, int32_t> partIndexByEntry;

  // Definition labels on the current recursion path, for cycle detection.
  std::vector<std::string> definitionStack;

  bool cyclic = false;
};

// Resolves a part label to its index in the body list, registering it the first
// time it is seen.
int32_t partIndexFor(StructureWalk& walk, const TDF_Label& definition) {
  const std::string entry = labelEntry(definition);
  const std::map<std::string, int32_t>::const_iterator found =
      walk.partIndexByEntry.find(entry);
  if (found != walk.partIndexByEntry.end()) return found->second;

  const TopoDS_Shape shape = XCAFDoc_ShapeTool::GetShape(definition);
  if (!importedShapeIsUsable(shape)) {
    // A part label with no usable shape, counted where every other shape the
    // file offered but this system could not hold is counted. The occurrence
    // referencing it survives with no part rather than the whole import failing
    // over one empty leaf.
    ++walk.out->unregisteredShapeCount;
    walk.partIndexByEntry.emplace(entry, -1);
    return -1;
  }

  const int32_t index = static_cast<int32_t>(walk.partShapes.size());
  walk.partShapes.push_back(shape);

  StepPart part;
  part.name = labelName(definition);
  readPartAppearance(definition, shape, part, walk.out->faceColours);
  walk.out->parts.push_back(std::move(part));

  walk.partIndexByEntry.emplace(entry, index);
  return index;
}

// Adds one occurrence and everything beneath it.
//
// The occurrence label is where the placement and the occurrence name come
// from - a component label, or the free-shape label itself at a root. The
// definition label is what it refers to: an assembly whose components are
// walked in turn, or a simple shape that becomes a part. Keeping the two
// apart is what makes an instance-level fact distinguishable from a
// part-level one, here and everywhere above.
void walkOccurrence(StructureWalk& walk,
                    const TDF_Label& occurrence,
                    const TDF_Label& definition,
                    int32_t parent,
                    uint32_t depth) {
  if (walk.cyclic) return;

  const std::string entry = labelEntry(definition);
  if (std::find(walk.definitionStack.begin(), walk.definitionStack.end(), entry) !=
      walk.definitionStack.end()) {
    // An assembly containing itself. STEP's own rules forbid it and OCCT's
    // reader is not expected to produce one, which is exactly why this is
    // checked rather than assumed: the alternative to a check here is unbounded
    // recursion inside a WASM module, which is not a failure anyone can
    // diagnose from the outside.
    walk.cyclic = true;
    return;
  }

  StepImportResult& out = *walk.out;
  const int32_t index = static_cast<int32_t>(out.instances.size());

  StepInstance node;
  node.parent = parent;
  node.name = labelName(occurrence);

  // Only a genuine component reference can carry an occurrence colour. At a
  // root the occurrence and the definition are the same label, so reading one
  // there would report the PART's colour as an override and destroy exactly
  // the distinction the two fields exist to keep.
  if (!occurrence.IsEqual(definition)) {
    Quantity_Color colour;
    bool found = labelColour(occurrence, colour);

    // An override does not live on the component label. AP214's
    // CONTEXT_DEPENDENT_OVER_RIDING_STYLED_ITEM is routed through
    // SetAssemblyComponentStyle into a SHUO, so the label read above finds
    // nothing and the SHUO has to be asked directly.
    if (!found) found = occurrenceOverride(walk.colourTool, occurrence, colour);

    if (found) {
      node.hasColour = true;
      writeColour(colour, node.colourR, node.colourG, node.colourB);
    }
  }

  out.instances.push_back(std::move(node));

  // Appended in lockstep with the instance, which is what makes "12 doubles at
  // 12 times the instance's own index" true by construction rather than by
  // discipline.
  appendPlacement(XCAFDoc_ShapeTool::GetLocation(occurrence), out.placements);
  out.treeDepth = std::max(out.treeDepth, depth);

  if (!XCAFDoc_ShapeTool::IsAssembly(definition)) {
    out.instances[static_cast<size_t>(index)].part = partIndexFor(walk, definition);
    return;
  }

  // Counted here rather than by scanning for part == -1 afterwards: a part
  // whose shape turned out unusable also leaves -1 behind, and the two are not
  // the same finding.
  ++out.groupingNodeCount;

  walk.definitionStack.push_back(entry);
  NCollection_Sequence<TDF_Label> components;
  XCAFDoc_ShapeTool::GetComponents(definition, components);
  for (int i = 1; i <= components.Length(); ++i) {
    const TDF_Label component = components.Value(i);
    TDF_Label referred;
    if (!XCAFDoc_ShapeTool::GetReferredShape(component, referred)) {
      // A component pointing at nothing. Its subtree is unreachable by
      // definition, so it is skipped and counted rather than treated as a
      // reason to refuse the file - the same judgement that admits open shells.
      ++out.unresolvedInstanceCount;
      continue;
    }
    walkOccurrence(walk, component, referred, index, depth + 1);
    if (walk.cyclic) break;
  }
  walk.definitionStack.pop_back();
}

// Names a length unit from its millimetre factor, for reporting.
//
// OCCT carries units as a factor rather than a name once a model is loaded, and
// a factor in a report is harder to read than a name. Anything unrecognized is
// reported as its factor rather than forced into the nearest name.
std::string lengthUnitName(double millimetresPerUnit) {
  struct Known {
    double factor;
    const char* name;
  };
  static const Known kKnown[] = {
      {1.0, "mm"}, {10.0, "cm"}, {1000.0, "m"},
      {25.4, "in"}, {304.8, "ft"}, {0.001, "um"},
  };
  for (const Known& k : kKnown) {
    if (std::fabs(millimetresPerUnit - k.factor) < 1e-9 * k.factor) {
      return k.name;
    }
  }
  std::ostringstream os;
  os << millimetresPerUnit << "mm";
  return os.str();
}

// --- Shared STEP reporting --------------------------------------------------

// Reports the unit the file declared and the unit the bodies came out in.
//
// FileUnits gives the unit names per shape representation, read before the
// transfer that converts them; the transfer then expresses everything in the
// system unit. Both are reported, and the conversion between them happens here
// and nowhere else downstream.
void reportUnits(STEPControl_Reader& reader, StepImportResult& out) {
  NCollection_Sequence<TCollection_AsciiString> unitLengths;
  NCollection_Sequence<TCollection_AsciiString> unitAngles;
  NCollection_Sequence<TCollection_AsciiString> unitSolidAngles;
  reader.FileUnits(unitLengths, unitAngles, unitSolidAngles);
  for (int i = 1; i <= unitLengths.Length(); ++i) {
    const std::string name(unitLengths.Value(i).ToCString());
    if (name.empty()) continue;
    if (out.declaredUnit.empty()) {
      out.declaredUnit = name;
    } else if (out.declaredUnit.find(name) == std::string::npos) {
      // A file whose representations disagree about units is a real thing.
      // Reported rather than resolved to the first one seen.
      out.declaredUnit += "," + name;
    }
  }
  out.workingUnit = lengthUnitName(reader.SystemLengthUnit());
  out.unitWasAssumed = out.declaredUnit.empty();
}

// Counts entity kinds off the parsed STEP model.
//
// These are counts of kinds - no entity crosses the boundary - and they are
// taken from the model rather than from what the transfer produced, so they
// say what the FILE declared. That makes them the denominator for what
// arrived, and it makes them identical in both reader modes, which is what
// lets the two be compared at all.
//
// The dropped categories are counted here rather than read into a document.
// The CAF reader can build layers, validation properties, tolerances and
// materials as attributes, and this stage discards all four - so paying to
// build them would show up in the reader-cost comparison as a cost of
// structure, which it is not. Counting the entities costs one pass that is
// already being made.
void censusEntities(const occ::handle<Interface_InterfaceModel>& model,
                    StepImportResult& out) {
  if (model.IsNull()) return;
  for (int i = 1; i <= model->NbEntities(); ++i) {
    const occ::handle<Standard_Transient> entity = model->Value(i);
    if (entity.IsNull()) continue;
    if (entity->IsKind(STANDARD_TYPE(StepVisual_StyledItem))) {
      ++out.styledItemCount;
    }
    if (entity->IsKind(STANDARD_TYPE(StepRepr_NextAssemblyUsageOccurrence))) {
      ++out.assemblyNodeCount;
    }
    if (entity->IsKind(STANDARD_TYPE(StepBasic_Product))) {
      ++out.namedProductCount;
    }
    if (entity->IsKind(STANDARD_TYPE(StepVisual_PresentationLayerAssignment))) {
      ++out.droppedLayerCount;
    }
    if (entity->IsKind(STANDARD_TYPE(StepRepr_MaterialDesignation))) {
      ++out.droppedMaterialCount;
    }
    if (entity->IsKind(STANDARD_TYPE(StepDimTol_GeometricTolerance))) {
      ++out.droppedGeometricToleranceCount;
    }
    if (entity->IsKind(STANDARD_TYPE(StepShape_DimensionalSize))) {
      ++out.droppedDimensionCount;
    }
  }
}

// Why an import produced nothing, in the words the census supports.
//
// "Contained no transferable shape" is true of a file with nothing in it and
// also of one whose structure the reader could not resolve - and the second
// reads as a lie to anyone who can see a solid in their file. The two are
// distinguishable: a census that counted assembly occurrences against a reader
// that resolved no root means the structure is what failed, not the geometry.
//
// Deliberately does not name a cause. A cyclic assembly produces exactly this
// signature, and so would several other defects; OCCT reports no error for any
// of them, so anything more specific would be a guess dressed as a diagnosis.
std::string emptyImportMessage(const StepImportResult& out) {
  if (out.rootShapeCount == 0 && out.assemblyNodeCount > 0) {
    return "STEP payload declares " + std::to_string(out.assemblyNodeCount) +
           " assembly occurrences but the reader resolved no root shape from them";
  }
  return "STEP payload contained no transferable shape";
}

// Registers imported shapes in order, filling in the handle fields.
//
// Returns false having registered nothing when the registry misbehaves, with
// the failure already recorded on the result. Shared by both reader modes so
// that the consecutive-handle guarantee and the open-body report are stated
// once: a structured import addresses its parts as firstBodyId + part index,
// which is the same promise a flat one makes and has to be kept the same way.
bool registerImported(const std::vector<TopoDS_Shape>& shapes,
                      StepImportResult& out) {
  std::vector<uint32_t> issued;
  issued.reserve(shapes.size());
  try {
    for (const TopoDS_Shape& shape : shapes) {
      issued.push_back(registry().add(shape));
    }
  } catch (...) {
    for (const uint32_t id : issued) registry().release(id);
    throw;
  }

  // As in restoreBodies: consecutive issuance is what lets a caller address
  // the i-th body as firstBodyId + i, and it is verified rather than trusted.
  for (size_t i = 0; i < issued.size(); ++i) {
    if (issued[i] != issued[0] + static_cast<uint32_t>(i)) {
      for (const uint32_t id : issued) registry().release(id);
      out.status = static_cast<int32_t>(Status::KernelOperationFailed);
      out.message = "registry issued non-consecutive handles";
      return false;
    }
  }

  // Validity is reported, not enforced. BRepCheck_Analyzer runs here - unlike
  // in restoreBodies, where the geometry had already been validated on the way
  // in - because for imported geometry its answer is the finding.
  for (size_t i = 0; i < shapes.size(); ++i) {
    const TopoDS_Shape& shape = shapes[i];
    const bool closedSolid = countSubShapes(shape, TopAbs_SOLID) > 0 &&
                             BRepCheck_Analyzer(shape).IsValid();
    if (!closedSolid) out.openBodyIds.push_back(issued[i]);
  }

  out.firstBodyId = issued[0];
  out.bodyCount = static_cast<uint32_t>(issued.size());
  return true;
}

// What OCCT's shape processing does when it is left enabled.
//
// Hardcoded rather than queried: the accessors that would enumerate the flags
// at run time (GetDefaultShapeProcessFlags) are protected, so the facade cannot
// read them. These are OCCT 8.0.1's defaults, verified in its source -
// STEPControl_Reader.cxx:864-867 for the reader, STEPControl_Controller.cxx:
// 348-353 for the writer. If a later OCCT changes them this string goes stale,
// which is why it names its source.
constexpr const char* kReaderDefaultProcessing = "FixShape";
constexpr const char* kWriterDefaultProcessing = "SplitCommonVertex,DirectFaces";

// Stops OCCT's translators narrating to the console.
//
// The STEP reader and writer send per-transfer statistics through OCCT's default
// messenger at Info gravity, unconditionally - banner lines, transfer modes, one
// block per shape. In a browser that is console noise from a library the
// application is meant to be hiding, and in a test run it buries the output.
//
// Info is dropped and Warning upwards is kept: a translator that has something
// real to report must still be able to say so. Applied once, lazily, because
// there is no facade initialization hook and the messenger is global.
void quietOcctChatter() {
  static bool done = false;
  if (done) return;
  done = true;

  const occ::handle<Message_Messenger>& messenger = Message::DefaultMessenger();
  if (messenger.IsNull()) return;
  for (const occ::handle<Message_Printer>& printer : messenger->Printers()) {
    if (!printer.IsNull()) printer->SetTraceLevel(Message_Warning);
  }
}

}  // namespace

OpResult createBox(const BoxParams& p) {
  if (!(p.width > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "width must be positive");
  }
  if (!(p.depth > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "depth must be positive");
  }
  if (!(p.height > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "height must be positive");
  }
  if (p.angle != 0.0 && !axisIsUsable(p.axisX, p.axisY, p.axisZ)) {
    return fail<OpResult>(Status::InvalidParameter,
                          "rotation axis must not be zero-length");
  }

  return guarded<OpResult>([&] {
    // Built at the origin, then placed, so rotation is about the box's own
    // minimum corner rather than the world origin.
    TopoDS_Shape shape =
        BRepPrimAPI_MakeBox(p.width, p.depth, p.height).Shape();

    gp_Trsf rotation;
    if (p.angle != 0.0) {
      rotation.SetRotation(
          gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(p.axisX, p.axisY, p.axisZ)),
          p.angle);
    }
    gp_Trsf translation;
    translation.SetTranslation(gp_Vec(p.originX, p.originY, p.originZ));

    shape = BRepBuilderAPI_Transform(shape, translation * rotation, true).Shape();
    return registerSolid(shape, "box");
  });
}

OpResult createCylinder(const CylinderParams& p) {
  if (!(p.radius > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "radius must be positive");
  }
  if (!(p.height > 0.0)) {
    return fail<OpResult>(Status::InvalidParameter, "height must be positive");
  }
  if (!axisIsUsable(p.axisX, p.axisY, p.axisZ)) {
    return fail<OpResult>(Status::InvalidParameter,
                          "axis must not be zero-length");
  }

  return guarded<OpResult>([&] {
    const gp_Ax2 axis(gp_Pnt(p.originX, p.originY, p.originZ),
                      gp_Dir(p.axisX, p.axisY, p.axisZ));
    const TopoDS_Shape shape =
        BRepPrimAPI_MakeCylinder(axis, p.radius, p.height).Shape();
    return registerSolid(shape, "cylinder");
  });
}

OpResult booleanOp(uint32_t targetId, uint32_t toolId, int32_t kind) {
  if (kind < 0 || kind > 2) {
    return fail<OpResult>(Status::InvalidParameter, "unknown boolean kind");
  }
  // Rejected before any geometry work: the same body as both operands is a
  // caller mistake, not a degenerate-geometry case to be computed.
  if (targetId == toolId) {
    return fail<OpResult>(Status::InvalidParameter,
                          "target and tool must be different bodies");
  }

  const TopoDS_Shape* target = registry().find(targetId);
  if (target == nullptr) {
    return fail<OpResult>(Status::InvalidHandle, "unknown target body");
  }
  const TopoDS_Shape* tool = registry().find(toolId);
  if (tool == nullptr) {
    return fail<OpResult>(Status::InvalidHandle, "unknown tool body");
  }

  // Copied out of the registry before the operation: BRepAlgoAPI may modify its
  // inputs' internal state, and the operands must stay usable afterwards.
  const TopoDS_Shape a = *target;
  const TopoDS_Shape b = *tool;

  return guarded<OpResult>([&] {
    TopoDS_Shape result;
    const char* what = "boolean";

    switch (static_cast<BooleanKind>(kind)) {
      case BooleanKind::Union: {
        BRepAlgoAPI_Fuse op(a, b);
        if (!op.IsDone()) {
          return fail<OpResult>(Status::KernelOperationFailed, "union failed");
        }
        result = op.Shape();
        what = "union";
        break;
      }
      case BooleanKind::Subtract: {
        BRepAlgoAPI_Cut op(a, b);
        if (!op.IsDone()) {
          return fail<OpResult>(Status::KernelOperationFailed, "subtract failed");
        }
        result = op.Shape();
        what = "subtract";
        break;
      }
      case BooleanKind::Intersect: {
        BRepAlgoAPI_Common op(a, b);
        if (!op.IsDone()) {
          return fail<OpResult>(Status::KernelOperationFailed, "intersect failed");
        }
        result = op.Shape();
        what = "intersect";
        break;
      }
    }

    // An operation that removes all material, or intersects disjoint solids,
    // yields no solid. That is a legitimate outcome and is reported as
    // EmptyResult, distinct from a failure, and with no handle issued.
    if (result.IsNull() || countSubShapes(result, TopAbs_SOLID) == 0) {
      OpResult empty;
      empty.status = static_cast<int32_t>(Status::EmptyResult);
      empty.message = std::string(what) + " produced no solid";
      return empty;
    }

    // A disjoint union legitimately yields several solids. registerSolid
    // reports solidCount so the caller sees a multi-solid success rather than
    // having the result rejected.
    return registerSolid(result, what);
  });
}

MeshResult tessellate(uint32_t bodyId, const TessellationParams& p) {
  const double linear =
      p.linearDeflection > 0.0 ? p.linearDeflection : kDefaultLinearDeflection;
  const double angular =
      p.angularDeflection > 0.0 ? p.angularDeflection : kDefaultAngularDeflection;

  const TopoDS_Shape* found = registry().find(bodyId);
  if (found == nullptr) {
    return fail<MeshResult>(Status::InvalidHandle, "unknown body");
  }

  // A cache hit is reported explicitly rather than left to be inferred from
  // timing, so tests can assert it deterministically.
  if (const CachedMesh* hit = registry().findMesh(bodyId, linear, angular)) {
    MeshResult out;
    out.vertexCount = hit->vertexCount;
    out.triangleCount = hit->triangleCount;
    out.positionsPtr = reinterpret_cast<uint32_t>(hit->positions.data());
    out.normalsPtr = reinterpret_cast<uint32_t>(hit->normals.data());
    out.indicesPtr = reinterpret_cast<uint32_t>(hit->indices.data());
    out.faceRangesPtr = reinterpret_cast<uint32_t>(hit->faceRanges.data());
    out.faceRangeCount = static_cast<uint32_t>(hit->faceRanges.size() / 2);
    out.linearDeflection = linear;
    out.angularDeflection = angular;
    out.fromCache = true;
    return out;
  }

  const TopoDS_Shape shape = *found;

  return guarded<MeshResult>([&] {
    BRepMesh_IncrementalMesh mesher(shape, linear, false, angular,
                                    true);
    if (!mesher.IsDone()) {
      return fail<MeshResult>(Status::KernelOperationFailed,
                              "tessellation did not complete");
    }

    CachedMesh mesh;
    mesh.linearDeflection = linear;
    mesh.angularDeflection = angular;

    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
      const TopoDS_Face face = TopoDS::Face(exp.Current());
      const uint32_t rangeStart = static_cast<uint32_t>(mesh.indices.size());

      TopLoc_Location loc;
      const Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
      if (tri.IsNull()) {
        // One range per face VISITED, empty where nothing was emitted.
        // Recording only the productive faces would shift every later face's
        // position by one, and a per-face attribute keyed by position would
        // then land on the wrong face from here to the end of the shape -
        // silently, and only for shapes containing an untriangulated face.
        mesh.faceRanges.push_back(rangeStart);
        mesh.faceRanges.push_back(0);
        continue;
      }

      const gp_Trsf trsf = loc.Transformation();
      const bool reversed = face.Orientation() == TopAbs_REVERSED;
      const int nbNodes = tri->NbNodes();
      const int nbTris = tri->NbTriangles();

      // Vertices are emitted per face rather than shared across faces, so a
      // sharp edge between two faces keeps distinct normals on each side.
      const uint32_t base = mesh.vertexCount;

      for (int i = 1; i <= nbNodes; ++i) {
        gp_Pnt pt = tri->Node(i);
        pt.Transform(trsf);
        mesh.positions.push_back(static_cast<float>(pt.X()));
        mesh.positions.push_back(static_cast<float>(pt.Y()));
        mesh.positions.push_back(static_cast<float>(pt.Z()));
        // Accumulated from adjacent triangles below.
        mesh.normals.insert(mesh.normals.end(), {0.0f, 0.0f, 0.0f});
      }
      mesh.vertexCount += static_cast<uint32_t>(nbNodes);

      for (int t = 1; t <= nbTris; ++t) {
        int a = 0, b = 0, c = 0;
        tri->Triangle(t).Get(a, b, c);
        if (reversed) {
          std::swap(b, c);
        }

        const uint32_t ia = base + static_cast<uint32_t>(a - 1);
        const uint32_t ib = base + static_cast<uint32_t>(b - 1);
        const uint32_t ic = base + static_cast<uint32_t>(c - 1);
        mesh.indices.push_back(ia);
        mesh.indices.push_back(ib);
        mesh.indices.push_back(ic);

        // Area-weighted face normal accumulated onto each corner. Within a
        // single face this smooths a curved surface such as a cylinder's
        // lateral face; across faces nothing is shared, so planes stay flat.
        const gp_Vec va(mesh.positions[3 * ia], mesh.positions[3 * ia + 1],
                        mesh.positions[3 * ia + 2]);
        const gp_Vec vb(mesh.positions[3 * ib], mesh.positions[3 * ib + 1],
                        mesh.positions[3 * ib + 2]);
        const gp_Vec vc(mesh.positions[3 * ic], mesh.positions[3 * ic + 1],
                        mesh.positions[3 * ic + 2]);
        const gp_Vec n = (vb - va).Crossed(vc - va);

        for (uint32_t idx : {ia, ib, ic}) {
          mesh.normals[3 * idx] += static_cast<float>(n.X());
          mesh.normals[3 * idx + 1] += static_cast<float>(n.Y());
          mesh.normals[3 * idx + 2] += static_cast<float>(n.Z());
        }
      }
      mesh.triangleCount += static_cast<uint32_t>(nbTris);
      mesh.faceRanges.push_back(rangeStart);
      mesh.faceRanges.push_back(static_cast<uint32_t>(mesh.indices.size()) -
                                rangeStart);
    }

    // The ranges have to tile the index buffer: contiguous from zero, no gap,
    // no overlap, ending exactly at the end. Checked rather than asserted in a
    // comment, because everything downstream reads a per-face attribute by
    // walking these, and a range that is off by one triangle is a colour on
    // the wrong face rather than a crash.
    {
      uint32_t covered = 0;
      for (size_t i = 0; i + 1 < mesh.faceRanges.size(); i += 2) {
        if (mesh.faceRanges[i] != covered) {
          return fail<MeshResult>(
              Status::KernelOperationFailed,
              "face range " + std::to_string(i / 2) + " starts at " +
                  std::to_string(mesh.faceRanges[i]) + ", expected " +
                  std::to_string(covered));
        }
        covered += mesh.faceRanges[i + 1];
      }
      if (covered != mesh.indices.size()) {
        return fail<MeshResult>(
            Status::KernelOperationFailed,
            "face ranges cover " + std::to_string(covered) + " of " +
                std::to_string(mesh.indices.size()) + " indices");
      }
    }

    if (mesh.vertexCount == 0 || mesh.triangleCount == 0) {
      return fail<MeshResult>(Status::KernelOperationFailed,
                              "tessellation produced no triangles");
    }

    for (size_t i = 0; i + 2 < mesh.normals.size(); i += 3) {
      const float x = mesh.normals[i];
      const float y = mesh.normals[i + 1];
      const float z = mesh.normals[i + 2];
      const float len = std::sqrt(x * x + y * y + z * z);
      if (len > 0.0f) {
        mesh.normals[i] = x / len;
        mesh.normals[i + 1] = y / len;
        mesh.normals[i + 2] = z / len;
      } else {
        mesh.normals[i + 2] = 1.0f;
      }
    }

    MeshResult out;
    out.vertexCount = mesh.vertexCount;
    out.triangleCount = mesh.triangleCount;
    out.linearDeflection = linear;
    out.angularDeflection = angular;
    out.fromCache = false;

    // Pointers must address the stored copy, not the local, so they stay valid
    // after this function returns.
    const CachedMesh* stored = registry().storeMesh(bodyId, std::move(mesh));
    out.positionsPtr = reinterpret_cast<uint32_t>(stored->positions.data());
    out.normalsPtr = reinterpret_cast<uint32_t>(stored->normals.data());
    out.indicesPtr = reinterpret_cast<uint32_t>(stored->indices.data());
    out.faceRangesPtr = reinterpret_cast<uint32_t>(stored->faceRanges.data());
    out.faceRangeCount = static_cast<uint32_t>(stored->faceRanges.size() / 2);
    return out;
  });
}

OpResult releaseBody(uint32_t bodyId) {
  // Covers both the unknown-handle and double-release cases: neither corrupts
  // kernel state nor frees unrelated geometry.
  if (!registry().release(bodyId)) {
    return fail<OpResult>(Status::InvalidHandle,
                          "unknown or already-released body");
  }
  sampleMemory();
  return OpResult{};
}

BodyInfo bodyInfo(uint32_t bodyId) {
  const TopoDS_Shape* found = registry().find(bodyId);
  if (found == nullptr) {
    return fail<BodyInfo>(Status::InvalidHandle, "unknown body");
  }
  const TopoDS_Shape shape = *found;

  return guarded<BodyInfo>([&] {
    BodyInfo out;
    out.faceCount = countSubShapes(shape, TopAbs_FACE);
    out.edgeCount = countSubShapes(shape, TopAbs_EDGE);
    out.vertexCount = countSubShapes(shape, TopAbs_VERTEX);
    out.solidCount = countSubShapes(shape, TopAbs_SOLID);

    GProp_GProps volumeProps;
    BRepGProp::VolumeProperties(shape, volumeProps);
    out.volume = volumeProps.Mass();

    GProp_GProps surfaceProps;
    BRepGProp::SurfaceProperties(shape, surfaceProps);
    out.area = surfaceProps.Mass();

    Bnd_Box box;
    BRepBndLib::Add(shape, box);
    if (!box.IsVoid()) {
      box.Get(out.bboxMinX, out.bboxMinY, out.bboxMinZ,
              out.bboxMaxX, out.bboxMaxY, out.bboxMaxZ);
    }

    out.isValid = isValidSolid(shape);
    out.isClosed = shape.Closed() ;
    return out;
  });
}

FaceTypeSummary faceTypeSummary(uint32_t bodyId) {
  const TopoDS_Shape* found = registry().find(bodyId);
  if (found == nullptr) {
    return fail<FaceTypeSummary>(Status::InvalidHandle, "unknown body");
  }
  const TopoDS_Shape shape = *found;

  return guarded<FaceTypeSummary>([&] {
    FaceTypeSummary out;
    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
      BRepAdaptor_Surface surface(TopoDS::Face(exp.Current()));
      switch (surface.GetType()) {
        case GeomAbs_Plane:            ++out.plane; break;
        case GeomAbs_Cylinder:         ++out.cylinder; break;
        case GeomAbs_Cone:             ++out.cone; break;
        case GeomAbs_Sphere:           ++out.sphere; break;
        case GeomAbs_Torus:            ++out.torus; break;
        case GeomAbs_BezierSurface:    ++out.bezier; break;
        case GeomAbs_BSplineSurface:   ++out.bspline; break;
        case GeomAbs_SurfaceOfRevolution: ++out.revolution; break;
        case GeomAbs_SurfaceOfExtrusion:  ++out.extrusion; break;
        default:                       ++out.other; break;
      }
    }
    return out;
  });
}

std::string geometryFormat() {
  return "occt-bin-brep-v" +
         std::to_string(static_cast<int>(BinTools_FormatVersion_CURRENT));
}

void discardStaging() {
  // swap-with-empty rather than clear(): clear() keeps the capacity, and the
  // point of discarding is to stop holding a checkpoint-sized allocation.
  std::string().swap(g_staging);
}

StagingResult reserveStaging(uint32_t byteLength) {
  if (byteLength == 0) {
    return fail<StagingResult>(Status::InvalidParameter,
                               "payload length must be positive");
  }

  return guarded<StagingResult>([&] {
    discardStaging();
    g_staging.resize(byteLength);

    StagingResult out;
    out.dataPtr = reinterpret_cast<uint32_t>(g_staging.data());
    out.byteLength = byteLength;
    return out;
  });
}

SerializeResult serializeBodies(const std::vector<uint32_t>& bodyIds) {
  // Resolved up front, before a single byte is written: a set containing an
  // unknown handle must fail having produced nothing, not a partial payload
  // that a caller might store.
  std::vector<TopoDS_Shape> shapes;
  shapes.reserve(bodyIds.size());
  for (const uint32_t id : bodyIds) {
    const TopoDS_Shape* found = registry().find(id);
    if (found == nullptr) {
      return fail<SerializeResult>(
          Status::InvalidHandle,
          "unknown or already-released body " + std::to_string(id));
    }
    shapes.push_back(*found);
  }

  return guarded<SerializeResult>([&] {
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const TopoDS_Shape& shape : shapes) {
      builder.Add(compound, shape);
    }

    // withTriangles and withNormals are false: a checkpoint stores exact
    // geometry, and any mesh in it would be derived data at one tolerance.
    // An empty compound is written normally, so serializing no bodies yields a
    // valid payload that restores to no bodies rather than an unreadable one.
    std::ostringstream stream(std::ios::out | std::ios::binary);
    BinTools::Write(compound, stream, false, false,
                    BinTools_FormatVersion_CURRENT);

    // One copy out of the stream's own buffer, move-assigned so it is not two.
    // Measured rather than assumed away: the payload's byte length rides back
    // on the result, so its cost is attributable against the recorded duration.
    g_staging = stream.str();

    SerializeResult out;
    out.dataPtr = reinterpret_cast<uint32_t>(g_staging.data());
    out.byteLength = static_cast<uint32_t>(g_staging.size());
    out.bodyCount = static_cast<uint32_t>(shapes.size());
    out.format = geometryFormat();
    out.occtVersion = OCC_VERSION_COMPLETE;
    return out;
  });
}

RestoreResult restoreBodies() {
  if (g_staging.empty()) {
    return fail<RestoreResult>(Status::InvalidParameter,
                               "no payload has been staged");
  }

  return guarded<RestoreResult>([&] {
    // A second copy of the payload, for the same reason as the one in
    // serializeBodies: a standard string stream owns its buffer. Both are
    // visible in the recorded byte count, so neither is hidden.
    std::istringstream stream(g_staging, std::ios::in | std::ios::binary);

    TopoDS_Shape root;
    BinTools::Read(root, stream);

    if (root.IsNull()) {
      return fail<RestoreResult>(Status::KernelOperationFailed,
                                 "payload contained no shape");
    }
    // Every payload this kernel writes has a compound at its root. Anything
    // else parsed successfully but was not written here, and restoring it
    // would mean guessing at a body layout.
    if (root.ShapeType() != TopAbs_COMPOUND) {
      return fail<RestoreResult>(Status::KernelOperationFailed,
                                 "payload is not a webcad checkpoint");
    }

    // Collected and checked before anything is registered, so the all-or-
    // nothing guarantee does not depend on unwinding a partial registration.
    std::vector<TopoDS_Shape> bodies;
    for (TopoDS_Iterator it(root); it.More(); it.Next()) {
      const TopoDS_Shape& child = it.Value();
      if (child.IsNull() || countSubShapes(child, TopAbs_SOLID) == 0) {
        return fail<RestoreResult>(
            Status::KernelOperationFailed,
            "payload contains a body with no solid at position " +
                std::to_string(bodies.size()));
      }
      bodies.push_back(child);
    }

    // Note what is NOT done here: BRepCheck_Analyzer is not run on each body.
    // Creation already validated this geometry, and a full validity analysis
    // over every body is proportional to model size at exactly the moment the
    // user is waiting for their document to open. Stream integrity is BinTools'
    // job and payload integrity is the document manifest's; re-deciding
    // validity is neither. A caller that wants it can ask bodyInfo.
    RestoreResult out;
    out.bodyCount = static_cast<uint32_t>(bodies.size());
    if (bodies.empty()) {
      return out;
    }

    std::vector<uint32_t> issued;
    issued.reserve(bodies.size());
    try {
      for (const TopoDS_Shape& body : bodies) {
        issued.push_back(registry().add(body));
      }
    } catch (...) {
      for (const uint32_t id : issued) registry().release(id);
      throw;
    }

    // The registry issues handles consecutively and never reuses one, which is
    // what lets a caller address the i-th body as firstBodyId + i instead of
    // receiving a list. Verified rather than assumed, so a future change to
    // handle allocation fails loudly here instead of silently misaddressing
    // every body in a restored document.
    for (size_t i = 0; i < issued.size(); ++i) {
      if (issued[i] != issued[0] + static_cast<uint32_t>(i)) {
        for (const uint32_t id : issued) registry().release(id);
        return fail<RestoreResult>(Status::KernelOperationFailed,
                                   "registry issued non-consecutive handles");
      }
    }

    out.firstBodyId = issued[0];
    return out;
  });
}

namespace {

// Reads the staged payload as shapes alone, the way MVP-2 did.
//
// Kept as its own function rather than as a branch inside the structured path.
// The two differ in almost everything - which reader, which OCCT subsystem,
// what a "root" is, whether compounds flatten - and interleaving them would
// make the cheap mode carry the expensive one's caveats in every comment.
StepImportResult importStepFlat(const StepTranslationOptions& options) {
  StepImportResult out;
  out.payloadByteLength = static_cast<uint32_t>(g_staging.size());
  out.structureRequested = false;

  STEPControl_Reader reader;
  if (!options.shapeProcessing) {
    // An empty flag set is what disables the pass; OCCT's own default enables
    // FixShape. Suppressed by default here so a difference between the file
    // and the body is attributable to translation rather than to repair.
    reader.SetShapeProcessFlags(ShapeProcess::OperationsFlags{});
  } else {
    out.shapeProcessing = kReaderDefaultProcessing;
  }

  // The bytes are read from a stream over the staging buffer rather than
  // through a virtual filesystem: no MEMFS, no second copy of the payload at
  // exactly the size where memory is the constraint, and no path namespace to
  // clean up on failure.
  std::istringstream stream(g_staging, std::ios::in | std::ios::binary);
  const IFSelect_ReturnStatus readStatus = reader.ReadStream("staged", stream);
  if (readStatus != IFSelect_RetDone) {
    // Covers bytes that are not STEP and a payload cut short partway: OCCT
    // reports both as a failed load, and neither may register the entities it
    // managed to parse, or a partial import could be mistaken for a whole one.
    return fail<StepImportResult>(
        Status::TranslationFailed,
        "payload could not be read as STEP (status " +
            std::to_string(static_cast<int>(readStatus)) + ")");
  }

  reportUnits(reader, out);
  censusEntities(reader.Model(), out);

  out.rootShapeCount = static_cast<uint32_t>(reader.NbRootsForTransfer());
  reader.TransferRoots();

  // Every transferred shape, flattened through compounds, gathered and
  // checked before anything is registered - so the all-or-nothing guarantee
  // does not depend on unwinding a partial registration.
  std::vector<TopoDS_Shape> leaves;
  for (int i = 1; i <= reader.NbShapes(); ++i) {
    collectLeafShapes(reader.Shape(i), leaves);
  }

  std::vector<TopoDS_Shape> usable;
  usable.reserve(leaves.size());
  for (const TopoDS_Shape& leaf : leaves) {
    if (importedShapeIsUsable(leaf)) {
      usable.push_back(leaf);
    } else {
      ++out.unregisteredShapeCount;
    }
  }

  if (usable.empty()) {
    // A syntactically valid file that yielded nothing this system can hold.
    // Reported as an empty result, distinct from the parse failure above,
    // because the two mean different things to a caller.
    //
    // Set on `out` rather than returned through fail<>, which would hand back
    // a fresh struct and throw away the unit and dropped-semantics fields
    // already gathered. Those are exactly what makes this outcome diagnosable
    // - how many roots the file offered, and how many were skipped - so
    // losing them here would make the report useless in the one case a caller
    // most needs to understand.
    out.status = static_cast<int32_t>(Status::EmptyResult);
    out.message = emptyImportMessage(out);
    return out;
  }

  registerImported(usable, out);
  return out;
}

// Reads the staged payload through XCAF, into a document discarded before this
// returns.
//
// The document is a translation vehicle and never the document of record: the
// native container owns structure once this call is over, and nothing that
// leaves here can be resolved back into a label. What crosses is indices,
// numbers, and text.
StepImportResult importStepStructured(const StepTranslationOptions& options) {
  StepImportResult out;
  out.payloadByteLength = static_cast<uint32_t>(g_staging.size());
  out.structureRequested = true;

  STEPCAFControl_Reader reader;

  // On: the three things this stage preserves. Off: the five it does not.
  //
  // Turning the rest off is not an optimization detail, it is what makes the
  // reader-cost comparison honest. Left on, the CAF reader would build layer,
  // property, tolerance and material attributes into a document this stage
  // discards, and the resulting cost would be charged to "reading structure"
  // in the findings.
  //
  // SHUO mode is on, and group 4 had it off. A specified higher usage
  // occurrence is not a category this stage drops - it is where an
  // occurrence's own colour LIVES, because AP214 attaches a per-occurrence
  // override to one and OCCT reads those only when this is set. Off, a file
  // whose overrides are written that way would lose every one of them
  // silently, while the reader looked like it had checked.
  reader.SetNameMode(true);
  reader.SetColorMode(true);
  reader.SetSHUOMode(true);
  reader.SetLayerMode(false);
  reader.SetPropsMode(false);
  reader.SetGDTMode(false);
  reader.SetMatMode(false);
  reader.SetViewMode(false);
  reader.SetMetaMode(false);

  STEPControl_Reader& plain = reader.ChangeReader();
  if (!options.shapeProcessing) {
    plain.SetShapeProcessFlags(ShapeProcess::OperationsFlags{});
  } else {
    out.shapeProcessing = kReaderDefaultProcessing;
  }

  std::istringstream stream(g_staging, std::ios::in | std::ios::binary);
  const IFSelect_ReturnStatus readStatus = reader.ReadStream("staged", stream);
  if (readStatus != IFSelect_RetDone) {
    return fail<StepImportResult>(
        Status::TranslationFailed,
        "payload could not be read as STEP (status " +
            std::to_string(static_cast<int>(readStatus)) + ")");
  }

  reportUnits(plain, out);
  censusEntities(plain.Model(), out);
  out.rootShapeCount = static_cast<uint32_t>(reader.NbRootsForTransfer());

  // Everything from here to the end of the function runs with a scratch
  // document alive. It closes itself on every path out, including a throw.
  ScratchDocument scratch;
  if (scratch.isNull()) {
    return fail<StepImportResult>(Status::KernelOperationFailed,
                                  "an XCAF document could not be created");
  }

  // A transfer that reports failure having been offered nothing is not a
  // failure, it is an empty file - and the flat path already calls that
  // EmptyResult. Left undistinguished the two modes would answer differently
  // about the same bytes, and the difference is not cosmetic: EmptyResult is a
  // success reporting zero bodies while TranslationFailed becomes a thrown
  // error one layer up. So the root count decides, and a file that declared
  // roots and still would not transfer keeps saying so.
  if (!reader.Transfer(scratch.get()) && out.rootShapeCount > 0) {
    return fail<StepImportResult>(
        Status::TranslationFailed,
        "the file's " + std::to_string(out.rootShapeCount) +
            " root shapes parsed but could not be transferred");
  }

  const occ::handle<XCAFDoc_ShapeTool> shapeTool =
      XCAFDoc_DocumentTool::ShapeTool(scratch.get()->Main());
  if (shapeTool.IsNull()) {
    return fail<StepImportResult>(Status::KernelOperationFailed,
                                  "the transferred document has no shape tool");
  }

  NCollection_Sequence<TDF_Label> freeShapes;
  shapeTool->GetFreeShapes(freeShapes);

  bool anyAssembly = false;
  for (int i = 1; i <= freeShapes.Length(); ++i) {
    if (XCAFDoc_ShapeTool::IsAssembly(freeShapes.Value(i))) {
      anyAssembly = true;
      break;
    }
  }

  const occ::handle<XCAFDoc_ColorTool> colourTool =
      XCAFDoc_DocumentTool::ColorTool(scratch.get()->Main());

  StructureWalk walk;
  walk.out = &out;
  walk.colourTool = colourTool;

  if (anyAssembly) {
    out.structurePresent = true;
    for (int i = 1; i <= freeShapes.Length(); ++i) {
      const TDF_Label root = freeShapes.Value(i);
      walkOccurrence(walk, root, root, -1, 1);
      if (walk.cyclic) {
        return fail<StepImportResult>(
            Status::TranslationFailed,
            "the file's assembly structure contains a cycle");
      }
    }
  } else {
    // No product structure anywhere, so this mode produces exactly what the
    // flat one does: top-level shapes, compounds flattened, no tree invented.
    // Reported as structurePresent = false, which together with
    // structureRequested = true says "you asked and the file had none" rather
    // than "you did not ask".
    for (int i = 1; i <= freeShapes.Length(); ++i) {
      const TDF_Label root = freeShapes.Value(i);
      std::vector<TopoDS_Shape> leaves;
      collectLeafShapes(XCAFDoc_ShapeTool::GetShape(root), leaves);
      for (const TopoDS_Shape& leaf : leaves) {
        if (!importedShapeIsUsable(leaf)) {
          ++out.unregisteredShapeCount;
          continue;
        }
        walk.partShapes.push_back(leaf);
        StepPart part;
        // The label named one thing. When it flattened into several, none of
        // them is the thing it named, so none of them takes the name. A colour
        // still can, because a colour on a leaf of a compound is recorded
        // against that leaf and not against the compound.
        part.name = leaves.size() == 1 ? labelName(root) : std::string();
        readPartAppearance(root, leaf, part, out.faceColours);
        out.parts.push_back(std::move(part));
      }
    }
  }

  if (walk.partShapes.empty()) {
    // Structure may still have arrived - a tree of grouping nodes with no
    // geometry under any of them is a real, if useless, file - so the message
    // distinguishes that from a file with nothing in it at all. As in the flat
    // path, set on `out` rather than through fail<>, to keep the census that
    // makes the outcome diagnosable.
    out.status = static_cast<int32_t>(Status::EmptyResult);
    out.message = out.instances.empty()
                      ? emptyImportMessage(out)
                      : "STEP payload contained structure but no geometry";
    return out;
  }

  if (!registerImported(walk.partShapes, out)) return out;

  for (const StepInstance& node : out.instances) {
    if (!node.name.empty()) ++out.namedInstanceCount;
    if (node.hasColour) ++out.colouredInstanceCount;
  }
  for (const StepPart& part : out.parts) {
    if (!part.name.empty()) ++out.namedPartCount;
    if (part.hasColour) ++out.colouredPartCount;
    out.colouredFaceCount += part.colouredFaceCount;
  }

  return out;
}

}  // namespace

StepImportResult importStep(const StepTranslationOptions& options) {
  if (g_staging.empty()) {
    return fail<StepImportResult>(Status::InvalidParameter,
                                  "no payload has been staged");
  }

  quietOcctChatter();

  return guarded<StepImportResult>([&] {
    return options.structure ? importStepStructured(options) : importStepFlat(options);
  });
}

StepExportResult exportStep(const std::vector<uint32_t>& bodyIds,
                            const StepTranslationOptions& options) {
  if (bodyIds.empty()) {
    // Writing an interchange file describing nothing is not a useful outcome to
    // hand a caller, and the application refuses an empty export above this.
    return fail<StepExportResult>(Status::InvalidParameter,
                                  "no bodies to export");
  }

  // Resolved before a byte is written, as in serializeBodies: a set containing
  // an unknown handle must fail having produced nothing.
  std::vector<TopoDS_Shape> shapes;
  shapes.reserve(bodyIds.size());
  for (const uint32_t id : bodyIds) {
    const TopoDS_Shape* found = registry().find(id);
    if (found == nullptr) {
      return fail<StepExportResult>(
          Status::InvalidHandle,
          "unknown or already-released body " + std::to_string(id));
    }
    shapes.push_back(*found);
  }

  quietOcctChatter();

  return guarded<StepExportResult>([&] {
    StepExportResult out;

    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const TopoDS_Shape& shape : shapes) {
      builder.Add(compound, shape);
    }

    STEPControl_Writer writer;
    if (!options.shapeProcessing) {
      writer.SetShapeProcessFlags(ShapeProcess::OperationsFlags{});
    } else {
      out.shapeProcessing = kWriterDefaultProcessing;
    }

    // AsIs writes each shape as the STEP entity that matches what it already is,
    // rather than forcing everything to a faceted or shell-based form. Anything
    // else would discard exact geometry on the way out, which is the one thing
    // an export here must not do.
    const IFSelect_ReturnStatus transferStatus =
        writer.Transfer(compound, STEPControl_AsIs);
    if (transferStatus != IFSelect_RetDone) {
      return fail<StepExportResult>(
          Status::TranslationFailed,
          "bodies could not be transferred to STEP (status " +
              std::to_string(static_cast<int>(transferStatus)) + ")");
    }

    std::ostringstream stream(std::ios::out | std::ios::binary);
    const IFSelect_ReturnStatus writeStatus = writer.WriteStream(stream);
    if (writeStatus != IFSelect_RetDone) {
      return fail<StepExportResult>(
          Status::TranslationFailed,
          "STEP payload could not be written (status " +
              std::to_string(static_cast<int>(writeStatus)) + ")");
    }

    g_staging = stream.str();

    const Handle(StepData_StepModel) stepModel = writer.Model();
    out.unitWritten = stepModel.IsNull()
                          ? std::string()
                          : lengthUnitName(stepModel->WriteLengthUnit());
    out.dataPtr = reinterpret_cast<uint32_t>(g_staging.data());
    out.byteLength = static_cast<uint32_t>(g_staging.size());
    out.bodyCount = static_cast<uint32_t>(shapes.size());
    return out;
  });
}

KernelStats stats() {
  sampleMemory();
  KernelStats out;
  out.liveBodyCount = registry().liveBodyCount();
  out.totalBodiesCreated = registry().totalBodiesCreated();
  out.cachedMeshCount = registry().cachedMeshCount();
  out.wasmMemoryBytes = currentMemoryBytes();
  out.wasmPeakMemoryBytes = g_peakMemoryBytes;
  out.meshCacheBytes = static_cast<double>(registry().meshCacheBytes());
  // Reached through the same singleton a translation uses, so this counts what
  // that translation would have left behind, not a separate tally that could
  // drift from it.
  const occ::handle<TDocStd_Application> app = XCAFApp_Application::GetApplication();
  out.openTranslationDocuments =
      app.IsNull() ? 0 : static_cast<uint32_t>(app->NbDocuments());
  return out;
}

std::string occtVersion() { return OCC_VERSION_COMPLETE; }

}  // namespace webcad
