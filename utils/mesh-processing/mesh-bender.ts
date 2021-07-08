import { Component, Mesh, Vec2, ModelComponent, _decorator, Enum, CurveRange, clamp, Color, log } from 'cc';
import Spline from '../../spline';
import CubicBezierCurve from '../../cubic-bezier-curve';
import CurveSample from '../../curve-sample';
import MeshVertex, { MeshVertexFlags } from './mesh-vertex';
import SourceMesh from './source-mesh';
import MeshUtility from './mesh-utility';

const { ccclass, executeInEditMode } = _decorator;


/// <summary>
/// The mode used by <see cref="MeshBender"/> to bend meshes on the interval.
/// </summary>
export enum FillingMode {
    /// <summary>
    /// In this mode, source mesh will be placed on the interval by preserving mesh scale.
    /// Vertices that are beyond interval end will be placed on the interval end.
    /// </summary>
    Once,
    /// <summary>
    /// In this mode, the mesh will be repeated to fill the interval, preserving
    /// mesh scale.
    /// This filling process will stop when the remaining space is not enough to
    /// place a whole mesh, leading to an empty interval.
    /// </summary>
    Repeat,
    /// <summary>
    /// In this mode, the mesh is deformed along the X axis to fill exactly the interval.
    /// </summary>
    StretchToInterval
}

Enum(FillingMode)

export enum AlignType {
    None,
    Top,
    Bottom,
    Right,
    Left
}
Enum(AlignType)

export enum MirrorType {
    None,
    Z,
    Y
}
Enum(MirrorType)

export enum ValueType {
    Absolute,
    Percent
}
Enum(ValueType)

// fill helpfer
let _tempWidthRange = new Vec2();
let _tempHeightRange = new Vec2();
let _tempZOffset = 0;
let _tempYOffset = 0;
let _alignZOffset = 0;
let _alignYOffset = 0;
function _beginFill (meshBender: MeshBender) {
    let source = meshBender.source!;
    _tempZOffset = 0;
    _tempYOffset = 0;
    _alignZOffset = 0;
    _alignYOffset = 0;
    switch (meshBender.alignType) {
        case AlignType.None:
            break;
        case AlignType.Top:
            _alignYOffset = meshBender.alignOffset;
            _tempYOffset = - (source.minY + source.lengthY);
            break;
        case AlignType.Bottom:
            _alignYOffset = meshBender.alignOffset;
            _tempYOffset = - source.minY;
            break;
        case AlignType.Right:
            _alignZOffset = meshBender.alignOffset;
            _tempZOffset = - (source.minZ + source.lengthZ);
            break;
        case AlignType.Left:
            _alignZOffset = meshBender.alignOffset;
            _tempZOffset = - source.minZ;
            break;
    }

    _tempWidthRange.set(source.minZ + meshBender.widthRange.x * source.lengthZ, source.minZ + meshBender.widthRange.y * source.lengthZ);
    _tempHeightRange.set(source.minY + meshBender.heightRange.x * source.lengthY, source.minY + meshBender.heightRange.y * source.lengthY);
}

function _applyVert (meshBender: MeshBender, vert: MeshVertex, sample: CurveSample, distanceRatio: number) {
    vert = MeshVertex.pool.get().set(vert);
    vert.position.z = clamp(vert.position.z, _tempWidthRange.x, _tempWidthRange.y);
    vert.position.y = clamp(vert.position.y, _tempHeightRange.x, _tempHeightRange.y);

    vert.position.z += _tempZOffset;
    vert.position.y += _tempYOffset;
    if (meshBender.widthCurve) {
        vert.position.z *= meshBender.widthCurve.evaluate(distanceRatio, 0.5)!;
    }
    if (meshBender.heightCurve) {
        vert.position.y *= meshBender.heightCurve.evaluate(distanceRatio, 0.5)!;
    }
    vert.position.z += _alignZOffset;
    vert.position.y += _alignYOffset;

    if (meshBender.mirror === MirrorType.Y) {
        vert.position.y *= -1;
    }
    else if (meshBender.mirror === MirrorType.Z) {
        vert.position.z *= -1;
    }

    vert = sample.getBent(vert, vert);
    return vert;
}

function _endFill (meshBender: MeshBender, bentVertices: MeshVertex[], sampleCache: Map<string, CurveSample>, triangles?: number[]) {
    let vertexFlags = bentVertices[0].flag;

    let colors;
    if (meshBender.useCustomVertexColor) {
        vertexFlags |= MeshVertexFlags.Color;

        colors = [];
        for (let i = 0; i < bentVertices.length; i++) {
            colors.push(meshBender.customVertexColor);
        }
    }
    else {
        colors = (vertexFlags & MeshVertexFlags.Color) && bentVertices.map(b => b.color);
    }

    meshBender._vertexFlags = vertexFlags;

    MeshUtility.updateOrCreateModelMesh(meshBender.getComponent(ModelComponent)!, {
        positions: (vertexFlags & MeshVertexFlags.Position) && bentVertices.map(b => b.position),
        normals: (vertexFlags & MeshVertexFlags.Normal) && bentVertices.map(b => b.normal),
        tangents: (vertexFlags & MeshVertexFlags.Tangent) && bentVertices.map(b => b.tangent),
        uvs: (vertexFlags & MeshVertexFlags.UV) && bentVertices.map(b => b.uv),
        uv1s: (vertexFlags & MeshVertexFlags.UV1) && bentVertices.map(b => b.uv1),
        colors,
        indices: triangles || meshBender.source!.triangles
    });

    for (let i = 0; i < bentVertices.length; i++) {
        MeshVertex.pool.put(bentVertices[i]);
    }
    for (const iter of sampleCache) {
        CurveSample.pool.put(iter[1]);
    }
    sampleCache.clear();
}

@ccclass
@executeInEditMode
export default class MeshBender extends Component {
    private dirty = false;
    private result: Mesh | null = null;
    private useSpline = false;
    private spline: Spline | null = null;
    private intervalStart = 0;
    private intervalEnd = 0;
    private curve: CubicBezierCurve | null = null;
    private _sampleCache: Map<string, CurveSample> = new Map();

    _vertexFlags = 0;

    private _source: SourceMesh | null = null;
    /// <summary>
    /// The source mesh to bend.
    /// </summary>
    get source () { return this._source; }
    set source (value) {
        if (value == this._source) return;
        this.dirty = true;
        this._source = value;
    }

    private _mode: FillingMode = FillingMode.StretchToInterval;
    /// <summary>
    /// The scaling mode along the spline
    /// </summary>
    get mode () { return this._mode; }
    set mode (value) {
        if (value == this._mode) return;
        this.dirty = true;
        this._mode = value;
    }

    private _mirror = MirrorType.None;
    get mirror () { return this._mirror; }
    set mirror (value) {
        if (value == this._mirror) return;
        this.dirty = true;
        this._mirror = value;
    }

    private _useCustomVertexColor = false;
    get useCustomVertexColor () {
        return this._useCustomVertexColor;
    }
    set useCustomVertexColor (v) {
        this._useCustomVertexColor = v;
        this.dirty = true;
    }

    private _customVertexColor = new Color;
    get customVertexColor () {
        return this._customVertexColor;
    }
    set customVertexColor (v) {
        this._customVertexColor.set(v);
        this.dirty = true;
    }

    _offset = 0;
    get offset () {
        return this._offset;
    }
    set offset (value) {
        this._offset = value;
        this.dirty = true;
    }
    _offsetValueType = ValueType.Absolute;
    get offsetValueType () {
        return this._offsetValueType;
    }
    set offsetValueType (value) {
        this._offsetValueType = value;
        this.dirty = true;
    }

    get length () {
        if (this.useSpline) {
            return this.spline!.length;
        }
        else {
            return this.curve!.length;
        }
    }

    get calcOffset () {
        if (this.offsetValueType === ValueType.Absolute) {
            return this.offset;
        }
        else {
            return this.offset * this.length;
        }

    }


    _widthCurve: CurveRange | null = null;
    get widthCurve () {
        return this._widthCurve;
    }
    set widthCurve (value) {
        this._widthCurve = value;
        this.dirty = true;
    }

    _widthRange = new Vec2(0, 1)
    get widthRange () {
        return this._widthRange;
    }
    set widthRange (value) {
        this._widthRange.set(value);
        this.dirty = true;
    }

    _heightCurve: CurveRange | null = null;
    get heightCurve () {
        return this._heightCurve;
    }
    set heightCurve (value) {
        this._heightCurve = value;
        this.dirty = true;
    }

    _heightRange = new Vec2(0, 1)
    get heightRange () {
        return this._heightRange;
    }
    set heightRange (value) {
        this._heightRange.set(value);
        this.dirty = true;
    }

    _alignType = AlignType.None;
    get alignType () {
        return this._alignType;
    }
    set alignType (value) {
        this._alignType = value;
        this.dirty = true;
    }

    _alignOffset = 0;
    get alignOffset () {
        return this._alignOffset;
    }
    set alignOffset (value) {
        this._alignOffset = value;
        this.dirty = true;
    }

    /// <summary>
    /// Sets a curve along which the mesh will be bent.
    /// The mesh will be updated if the curve changes.
    /// </summary>
    /// <param name="curve">The <see cref="CubicBezierCurve"/> to bend the source mesh along.</param>
    public setInterval (curve: CubicBezierCurve) {
        if (this.curve == curve) return;
        if (curve == null) throw new Error("curve");
        if (this.curve != null) {
            this.curve.changed.removeListener(this.setDirty, this);
        }
        this.curve = curve;
        this.spline = null;
        curve.changed.addListener(this.setDirty, this);
        this.useSpline = false;
        this.dirty = true;
    }

    /// <summary>
    /// Sets a spline's interval along which the mesh will be bent.
    /// If interval end is absent or set to 0, the interval goes from start to spline length.
    /// The mesh will be update if any of the curve changes on the spline, including curves
    /// outside the given interval.
    /// </summary>
    /// <param name="spline">The <see cref="SplineMesh"/> to bend the source mesh along.</param>
    /// <param name="intervalStart">Distance from the spline start to place the mesh minimum X.<param>
    /// <param name="intervalEnd">Distance from the spline start to stop deforming the source mesh.</param>
    public setInterval1 (spline: Spline, intervalStart: number, intervalEnd = 0) {
        if (this.spline == spline && this.intervalStart == intervalStart && this.intervalEnd == intervalEnd) return;
        if (spline == null) throw new Error("spline");
        if (intervalStart < 0 || intervalStart >= spline.length) {
            throw new Error("interval start must be 0 or greater and lesser than spline length (was " + intervalStart + ")");
        }
        if (intervalEnd != 0 && intervalEnd <= intervalStart || intervalEnd > spline.length) {
            throw new Error("interval end must be 0 or greater than interval start, and lesser than spline length (was " + intervalEnd + ")");
        }
        if (this.spline != null) {
            // unlistening previous spline
            this.spline.curveChanged.removeListener(this.setDirty, this);
        }
        this.spline = spline;
        // listening new spline
        spline.curveChanged.addListener(this.setDirty, this);

        this.curve = null;
        this.intervalStart = intervalStart;
        this.intervalEnd = intervalEnd;
        this.useSpline = true;
        this.dirty = true;
    }

    public onEnable () {
        // if (GetComponent<MeshFilter>().sharedMesh != null) {
        //     result = GetComponent<MeshFilter>().sharedMesh;
        // } else {
        //     GetComponent<MeshFilter>().sharedMesh = result = new Mesh();
        //     result.name = "Generated by " + GetType().Name;
        // }
    }

    public update () {
        this.computeIfNeeded();
    }

    public computeIfNeeded () {
        if (this.dirty) {
            this.compute();
        }
    }

    private setDirty () {
        this.dirty = true;
    }

    /// <summary>
    /// Bend the mesh. This method may take time and should not be called more than necessary.
    /// Consider using <see cref="ComputeIfNeeded"/> for faster result.
    /// </summary>
    private compute () {
        this.dirty = false;
        switch (this.mode) {
            case FillingMode.Once:
                this.fillOnce();
                break;
            case FillingMode.Repeat:
                this.fillRepeat();
                break;
            case FillingMode.StretchToInterval:
                this.fillStretch();
                break;
        }
    }

    public onDestroy () {
        if (this.curve != null) {
            this.curve.changed.removeListener(this.compute);
        }
    }

    private fillOnce () {
        let sampleCache = this._sampleCache;

        let source = this.source!;
        let bentVertices: MeshVertex[] = [];

        _beginFill(this);

        let offset = this.calcOffset;
        // for each mesh vertex, we found its projection on the curve
        for (let j = 0; j < source.vertices.length; j++) {
            let vert = source.vertices[j];
            let distance = vert.position.x - source.minX + offset;
            let distanceRate = source.lengthX == 0 ? 0 : Math.abs(vert.position.x - source.minX) / source.lengthX;
            let cacheKey = '' + distance;
            let sample: CurveSample = sampleCache.get(cacheKey)!;
            if (!sample) {
                if (!this.useSpline) {
                    if (distance > this.curve!.length) continue;
                    sample = this.curve!.getSampleAtDistance(distance, CurveSample.pool.get());
                } else {
                    let distOnSpline = this.intervalStart + distance;
                    //if (true) { //spline.isLoop) {
                    while (distOnSpline > this.spline!.length) {
                        distOnSpline -= this.spline!.length;
                    }
                    //} else if (distOnSpline > spline.Length) {
                    //    continue;
                    //}
                    sample = this.spline!.getSampleAtDistance(distOnSpline);
                }
                sampleCache.set(cacheKey, sample);
            }

            vert = _applyVert(this, vert, sample, distanceRate);
            bentVertices.push(vert);
        }

        _endFill(this, bentVertices, sampleCache);
    }

    private fillRepeat () {
        let source = this.source!;
        let intervalLength = this.useSpline ?
            (this.intervalEnd == 0 ? this.spline!.length : this.intervalEnd) - this.intervalStart :
            this.curve!.length;
        let repetitionCount = Math.floor(intervalLength / source.lengthX);
        let sampleCache = this._sampleCache;

        let sourceVertices = source.vertices;

        // building triangles and UVs for the repeated mesh
        let triangles: number[] = [];
        for (let i = 0; i < repetitionCount + 1; i++) {
            for (let j = 0; j < source.triangles.length; j++) {
                triangles.push(source.triangles[j] + sourceVertices.length * i);
            }
        }

        _beginFill(this);

        // computing vertices and normals
        let bentVertices: MeshVertex[] = [];
        let offset = this.calcOffset;
        for (let i = 0; i < repetitionCount; i++) {
            // for each mesh vertex, we found its projection on the curve
            for (let j = 0; j < sourceVertices.length; j++) {
                let vert = sourceVertices[j];
                let distance = vert.position.x - source.minX + offset;
                let cacheKey = `${i}_${distance}`;
                let sample: CurveSample = sampleCache.get(cacheKey)!;
                if (!sample) {
                    if (!this.useSpline) {
                        if (distance > this.curve!.length) continue;
                        sample = this.curve!.getSampleAtDistance(distance, CurveSample.pool.get());
                    } else {
                        let distOnSpline = this.intervalStart + distance;
                        //if (true) { //spline.isLoop) {
                        while (distOnSpline > this.spline!.length) {
                            distOnSpline = this.spline!.length;
                        }
                        //} else if (distOnSpline > spline.Length) {
                        //    continue;
                        //}
                        sample = this.spline!.getSampleAtDistance(distOnSpline);
                    }
                    sampleCache.set(cacheKey, sample);
                }

                vert = _applyVert(this, vert, sample, distance / intervalLength);
                bentVertices.push(vert);
            }
            offset += source.lengthX;
        }

        // fill remaining length
        let remainingLength = (this.useSpline ? this.spline!.length : this.curve!.length) - offset;
        for (let i = 0; i < sourceVertices.length; i++) {
            let vert = sourceVertices[i];
            let distanceRate = source.lengthX == 0 ? 0 : Math.abs(vert.position.x - source.minX) / source.lengthX;
            let distance = offset + distanceRate * remainingLength;
            let cacheKey = '' + distance;
            let sample: CurveSample = sampleCache.get(cacheKey)!;
            if (!sample) {
                if (!this.useSpline) {
                    if (distance > this.curve!.length) continue;
                    sample = this.curve!.getSampleAtDistance(distance, CurveSample.pool.get());
                } else {
                    let distOnSpline = this.intervalStart + distance;
                    //if (true) { //spline.isLoop) {
                    while (distOnSpline > this.spline!.length) {
                        distOnSpline = this.spline!.length;
                    }
                    //} else if (distOnSpline > spline.Length) {
                    //    continue;
                    //}
                    sample = this.spline!.getSampleAtDistance(distOnSpline);
                }
                sampleCache.set(cacheKey, sample);
            }

            vert = _applyVert(this, vert, sample, distanceRate);
            bentVertices.push(vert);
        }

        _endFill(this, bentVertices, sampleCache, triangles);
    }

    private fillStretch () {

        let bentVertices: MeshVertex[] = [];
        let source = this.source!;
        let sampleCache = this._sampleCache;

        _beginFill(this);

        // for each mesh vertex, we found its projection on the curve
        for (let i = 0; i < source.vertices.length; i++) {
            let vert = source.vertices[i];
            let distanceRate = source.lengthX == 0 ? 0 : Math.abs(vert.position.x - source.minX) / source.lengthX;
            let cacheKey = '' + distanceRate;
            let sample: CurveSample = sampleCache.get(cacheKey)!;
            if (!sample) {
                if (!this.useSpline) {
                    sample = this.curve!.getSampleAtDistance(this.curve!.length * distanceRate, CurveSample.pool.get());
                } else {
                    let intervalLength = this.intervalEnd == 0 ? this.spline!.length - this.intervalStart : this.intervalEnd - this.intervalStart;
                    let distOnSpline = this.intervalStart + intervalLength * distanceRate;
                    if (distOnSpline > this.spline!.length) {
                        distOnSpline = this.spline!.length;
                        log("dist " + distOnSpline + " spline length " + this.spline!.length + " start " + this.intervalStart);
                    }

                    sample = this.spline!.getSampleAtDistance(distOnSpline);
                }
                sampleCache.set(cacheKey, sample);
            }

            vert = _applyVert(this, vert, sample, distanceRate);
            bentVertices.push(vert);
        }

        _endFill(this, bentVertices, sampleCache);
    }
}
