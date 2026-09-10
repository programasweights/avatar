#!/usr/bin/env python3
"""Build the original stylized Gangnam dancer on the bundled CC0 avatar rig.

Run: blender --background --python tools/build-gangnam-character.py -- \
       --preview /tmp/gangnam-character.png --blend /tmp/gangnam-character.blend
Or run directly with a Python environment containing bpy. No downloads, textures,
third-party likeness assets, or external animation files are used.
"""
from __future__ import annotations
import argparse
import math
import json
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
TAU = math.tau

def arguments():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'public/assets/character.glb')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/assets/gangnam-character.glb')
    parser.add_argument('--preview', type=Path)
    parser.add_argument('--blend', type=Path)
    return parser.parse_args(argv)


def material(name, color, roughness=.45, metallic=0):
    result = bpy.data.materials.new(name)
    result.diffuse_color = (*color, 1)
    result.use_nodes = True
    shader = result.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    return result


def smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def bind(obj, weights=None, bone=None):
    """Bind geometry in the original armature's coordinates without a new rest pose."""
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)
    if bone and bone.startswith('foot_'):
        # The toe of the shoe remains articulated with the original ball joint.
        foot=obj.vertex_groups.new(name=bone)
        ball=obj.vertex_groups.new(name='ball_'+bone[-1])
        for vertex in obj.data.vertices:
            amount=max(0.,min(1.,(-.025-vertex.co.y)/.095))
            foot.add([vertex.index],1-amount,'REPLACE')
            ball.add([vertex.index],amount,'REPLACE')
    elif bone:
        obj.vertex_groups.new(name=bone).add(list(range(len(obj.data.vertices))), 1., 'REPLACE')
    else:
        groups = {}
        for i, entry in enumerate(weights):
            for name, weight in entry.items():
                if weight <= 0:
                    continue
                group = groups.setdefault(name, obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name))
                group.add([i], weight, 'REPLACE')
    modifier = obj.modifiers.new('Original avatar skeleton', 'ARMATURE')
    modifier.object = RIG
    obj.parent = RIG
    return obj


def mesh(name, vertices, faces, mat, weights=None, bone=None, subdivision=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    smooth(obj)
    if subdivision:
        modifier = obj.modifiers.new('Tailored smooth surface', 'SUBSURF')
        modifier.levels = subdivision
        modifier.render_levels = subdivision
    return bind(obj, weights, bone)


def ellipsoid(name, location, scale, mat, bone, segments=32, rings=20):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    smooth(obj)
    return bind(obj, bone=bone)


def tube(name, points, radius, mat, bone):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 16
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spline = curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for p, coordinate in zip(spline.bezier_points, points):
        p.co = coordinate
        p.handle_left_type = 'AUTO'
        p.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target='MESH')
    obj = bpy.context.object
    obj.data.materials.append(mat)
    obj.select_set(False)
    return bind(obj, bone=bone)


def panel(name, points, mat, bone='spine_03', thickness=.003, bevel=.003):
    obj = mesh(name, points, [tuple(range(len(points)))], mat, weights=[costume_weights(Vector(p)) for p in points] if bone.startswith('spine_') else None, bone=None if bone.startswith('spine_') else bone)
    modifier = obj.modifiers.new('Fabric thickness', 'SOLIDIFY')
    modifier.thickness = thickness
    modifier = obj.modifiers.new('Soft seam', 'BEVEL')
    modifier.width = bevel
    modifier.segments = 3
    return obj


def torso_weights(z):
    anchors = [(1.00, 'pelvis'), (1.13, 'spine_01'), (1.245, 'spine_02'), (1.40, 'spine_03')]
    for (lo, a), (hi, b) in zip(anchors, anchors[1:]):
        if lo <= z <= hi:
            t = (z - lo) / (hi - lo)
            return {a: 1-t, b: t}
    return {anchors[0 if z < 1 else -1][1]: 1}


def loft(name, rings, mat, direction='z', weights_fn=None, segments=48):
    """Rings are (axis position, center1, center2, radius1, radius2)."""
    vertices, faces, weights = [], [], []
    for axis, c1, c2, r1, r2 in rings:
        for j in range(segments):
            theta = TAU*j/segments
            v = (c1+r1*math.sin(theta), c2-r2*math.cos(theta), axis) if direction == 'z' else (axis, c1-r1*math.cos(theta), c2+r2*math.sin(theta))
            vertices.append(v)
            weights.append(weights_fn(axis))
    for i in range(len(rings)-1):
        for j in range(segments):
            a, b = i*segments+j, i*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    faces.extend([tuple(reversed(range(segments))), tuple((len(rings)-1)*segments+j for j in range(segments))])
    return mesh(name, vertices, faces, mat, weights=weights, subdivision=1)


def costume():
    # The original hands keep all skin weights, vertex positions, and fingertip geometry.
    # Face, torso and legs are covered/replaced by the original costume geometry below.
    body = bpy.data.objects['SuperHero_Male']
    cache_original_skin(body)
    import bmesh
    bm = bmesh.new(); bm.from_mesh(body.data)
    doomed = [v for v in bm.verts if not (abs(v.co.x) > .690 and 1.34 < v.co.z < 1.55)]
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
    bm.to_mesh(body.data); bm.free()
    body.name = 'Original fully articulated hands'
    body.data.materials.clear(); body.data.materials.append(SKIN)
    smooth(body)
    for name in ('Eyes', 'Eyebrows', 'Icosphere'):
        obj = bpy.data.objects.get(name)
        if obj:
            bpy.data.objects.remove(obj, do_unlink=True)
    # Round silhouette, restrained shoulder width, and straight fabric surfaces.
    loft('Blue dinner jacket', [
        (.965,0,.034,.176,.107),(.974,0,.032,.182,.113),
        (1.04,0,.018,.193,.133),(1.14,0,.008,.197,.139),
        (1.24,0,.005,.195,.138),(1.34,0,.018,.211,.138),
        (1.42,0,.033,.234,.119),(1.48,0,.043,.228,.104),
        (1.512,0,.041,.170,.080),(1.532,0,.040,.075,.055)
    ], BLUE, weights_fn=torso_weights)
    # Black high-waisted trousers and naturally draped legs.
    loft('Tuxedo waistband',[(.883,0,.035,.165,.097),(.95,0,.029,.178,.108),(1.016,0,.025,.176,.105)],BLACK,weights_fn=lambda z:{'pelvis':1})
    for side,sign in [('l',1),('r',-1)]:
        def leg_weights(z,side=side):
            if z > .65: return {f'thigh_{side}':1}
            if z < .43: return {f'calf_{side}':1}
            t=(z-.43)/.22
            return {f'calf_{side}':1-t,f'thigh_{side}':t}
        loft(f'{side} straight trouser leg',[(.071,sign*.114,.066,.065,.066),(.079,sign*.114,.068,.066,.067),(.15,sign*.114,.073,.066,.068),(.27,sign*.114,.060,.063,.067),(.45,sign*.114,.040,.065,.072),(.56,sign*.114,.033,.075,.083),(.69,sign*.114,.036,.085,.089),(.84,sign*.100,.035,.090,.097),(.95,sign*.090,.035,.092,.094)],BLACK,weights_fn=leg_weights)
        # Patent loafers, toe box, and low black sole.
        ellipsoid(f'{side} patent loafer',(sign*.114,-.033,.065),(.070,.149,.063),SHOE,f'foot_{side}')
        ellipsoid(f'{side} sole',(sign*.114,-.034,.015),(.071,.148,.018),SOLE,f'foot_{side}')
        tube(f'{side} loafer vamp',[(sign*.114-.053,-.05,.091),(sign*.114,-.059,.108),(sign*.114+.053,-.05,.091)],.005,BLACK,f'foot_{side}')
        def arm_weights(x,side=side):
            t=max(0,min(1,(abs(x)-.41)/.105))
            return {f'upperarm_{side}':1-t,f'lowerarm_{side}':t}
        rings=[(.205,.057,1.452,.091,.093),(.26,.063,1.455,.090,.086),(.34,.069,1.455,.079,.074),(.44,.072,1.455,.066,.065),(.49,.071,1.455,.063,.060),(.59,.067,1.455,.055,.052),(.675,.065,1.455,.044,.042),(.687,.065,1.455,.044,.042)]
        if sign<0: rings=[(-x,y,z,r1,r2) for x,y,z,r1,r2 in reversed(rings)]
        loft(f'{side} tailored sleeve',rings,BLUE,direction='x',weights_fn=arm_weights)
        cuff=[(sign*x,.065,1.455,.041,.040) for x in (.684,.687,.709,.711)]
        if sign<0:cuff.reverse()
        loft(f'{side} white shirt cuff',cuff,WHITE,direction='x',weights_fn=lambda x,side=side:{f'lowerarm_{side}':1})
        ellipsoid(f'{side} cufflink',(sign*.699,.026,1.455),(.005,.0025,.006),GOLD,f'lowerarm_{side}',16,10)
    ellipsoid('Neck',(0,.037,1.548),(.061,.060,.085),SKIN,'neck_01')
    # Crisp white shirt panel and wide satin peak lapels, shaped to the jacket front.
    # Conform shirt and lapels to the round torso; a flat panel would cut through it.
    def front_y(x, z):
        anchors=[(.974,.032,.182,.113),(1.04,.018,.193,.133),(1.14,.008,.197,.139),(1.24,.005,.195,.138),(1.34,.018,.211,.138),(1.42,.033,.234,.119),(1.48,.043,.228,.104),(1.512,.041,.170,.080),(1.532,.040,.075,.055)]
        for a,b in zip(anchors,anchors[1:]):
            if a[0] <= z <= b[0]:
                t=(z-a[0])/(b[0]-a[0]); cy=a[1]*(1-t)+b[1]*t;rx=a[2]*(1-t)+b[2]*t;ry=a[3]*(1-t)+b[3]*t
                return cy-ry*math.sqrt(max(.05,1-(x/rx)**2))-.007
        return -.15
    vertices=[]; faces=[]
    for z,width in [(1.187,.01),(1.23,.032),(1.29,.047),(1.36,.066),(1.42,.09),(1.48,.076),(1.528,.052)]:
        for j in range(9):
            x=width*(j/4-1);vertices.append((x,front_y(x,z),z))
    for i in range(6):
        for j in range(8):
            a=i*9+j;faces.append((a,a+1,a+10,a+9))
    mesh('White shirt front',vertices,faces,WHITE,weights=[costume_weights(Vector(p)) for p in vertices])
    for sign in (-1,1):
        def mirrored(points):return [(sign*x, min(y,front_y(x,z)-.004),z) for x,y,z in points]
        panel(f'{sign} satin peaked lapel',mirrored([(.060,-.038,1.529),(.132,-.059,1.493),(.163,-.093,1.42),(.126,-.112,1.425),(.137,-.127,1.372),(.021,-.147,1.175),(.061,-.139,1.337),(.094,-.103,1.423)]),LAPEL)
        panel(f'{sign} shirt collar',mirrored([(.013,-.065,1.533),(.061,-.044,1.529),(.080,-.078,1.470),(.035,-.091,1.490)]),WHITE)
        # A gently folded bow tie, not flat triangles.
        points=mirrored([(.009,-.094,1.489),(.047,-.089,1.509),(.051,-.089,1.466),(.009,-.094,1.477)])
        panel(f'{sign} bow tie wing',points,LAPEL,thickness=.009,bevel=.004)
        # Flap pockets and single lapel pin keep the tailoring visible at medium distance.
        panel(f'{sign} jacket pocket',mirrored([(.100,-.124,1.132),(.176,-.082,1.151),(.176,-.083,1.132),(.100,-.125,1.111)]),BLUE_DARK,'spine_01')
    ellipsoid('Bow tie knot',(0,-.101,1.483),(.013,.009,.019),LAPEL,'spine_03',24,16)
    for z in (1.19,1.075):
        ellipsoid('Jacket button',(0,-.14 if z>1.1 else -.124,z),(.011,.005,.011),LAPEL,'spine_01' if z<1.1 else 'spine_02',20,12)
    panel('White pocket square',[(.105,-.118,1.40),(.148,-.102,1.406),(.142,-.108,1.424),(.13,-.108,1.415),(.117,-.116,1.429)],WHITE)


def face():
    # Original stylized likeness: round cheeks, broad jaw, small confident smile.
    rings=[(1.573,0,.013,.041,.040),(1.595,0,.012,.075,.068),
           (1.625,0,.014,.100,.085),(1.662,0,.020,.112,.098),
           (1.70,0,.023,.110,.099),(1.742,0,.028,.103,.098),
           (1.785,0,.033,.093,.083),(1.812,0,.035,.065,.057),
           (1.827,0,.035,.010,.010)]
    rings=[(1.742+(z-1.742)*.85 if z>1.742 else z,x,y,rx,ry) for z,x,y,rx,ry in rings]
    loft('Round sculpted face',rings,SKIN,weights_fn=lambda z:{'Head':1},segments=64)
    for sign in (-1,1):
        ellipsoid(f'{sign} ear',(sign*.107,.023,1.694),(.020,.024,.038),SKIN,'Head')
        ellipsoid(f'{sign} ear inner',(sign*.117,.005,1.695),(.007,.012,.021),SKIN_SHADOW,'Head',24,16)
        # Rounded cheek volume is continuous with the face surface.
    ellipsoid('Nose bridge',(0,-.079,1.690),(.018,.023,.038),SKIN,'Head')
    ellipsoid('Nose tip',(0,-.105,1.672),(.025,.018,.017),SKIN,'Head')
    for sign in (-1,1):
        ellipsoid(f'{sign} nose wing',(sign*.020,-.095,1.669),(.013,.014,.011),SKIN,'Head',24,16)
        ellipsoid(f'{sign} nostril',(sign*.016,-.106,1.664),(.006,.003,.0025),SKIN_SHADOW,'Head',20,12)
    tube('Confident smile',[(-.034,-.075,1.634),(-.017,-.083,1.632),(0,-.087,1.630),(.018,-.083,1.632),(.034,-.075,1.636)],.003,LIP,'Head')
    tube('Lower lip',[(-.020,-.080,1.625),(0,-.085,1.623),(.020,-.080,1.625)],.004,SKIN_LIP,'Head')
    # Thick wayfarer-style sunglasses with dark blue lenses and metallic corner pins.
    def lens_outline(cx, factor=1):
        # Rounded rectangular outline, angled down slightly toward the outside.
        points=[]
        width,height=.047*factor,.030*factor
        for i in range(48):
            a=TAU*i/48
            x=math.copysign(abs(math.cos(a))**.45,math.cos(a))*width
            z=math.copysign(abs(math.sin(a))**.55,math.sin(a))*height
            points.append((cx+x,-.102+abs(cx+x)*.20,1.712+z-.055*abs(cx+x)))
        return points
    for sign in (-1,1):
        points=lens_outline(sign*.053)
        tube(f'{sign} sunglass frame',points+[points[0]],.0058,LAPEL,'Head')
        smaller=lens_outline(sign*.053,.92)
        panel(f'{sign} dark lens',[(x,y+.001,z) for x,y,z in smaller],LENS,'Head',.003,.001)
        tube(f'{sign} sunglass temple',[(sign*.099,-.080,1.719),(sign*.113,-.027,1.713),(sign*.114,.025,1.704),(sign*.108,.040,1.684)],.0045,LAPEL,'Head')
        ellipsoid(f'{sign} sunglass corner',(sign*.094,-.085,1.728),(.004,.002,.002),GOLD,'Head',16,10)
    tube('Sunglass bridge',[(-.013,-.107,1.716),(0,-.111,1.72),(.013,-.107,1.716)],.0045,LAPEL,'Head')
    # A low swept cap follows the actual head surface, so it cannot sink into
    # the forehead and leave an accidental bald wedge when viewed obliquely.
    vertices=[];faces=[];segments=64;steps=16
    profile=[(1.68,.021,.114,.100),(1.70,.023,.113,.102),(1.742,.028,.107,.102),(1.778,.033,.099,.089),(1.803,.035,.075,.067),(1.820,.037,.043,.036),(1.831,.037,0,0)]
    def hair_profile(z):
        for a,b in zip(profile,profile[1:]):
            if a[0] <= z <= b[0]:
                t=(z-a[0])/(b[0]-a[0]);return tuple(a[i]*(1-t)+b[i]*t for i in (1,2,3))
        return (.037,0,0)
    for k in range(steps+1):
        t=k/steps
        for j in range(segments):
            a=TAU*j/segments;front=max(0,math.cos(a))
            bottom=1.688+.086*front**2+.002*math.sin(a)
            z=bottom+(1.831-bottom)*math.sin(t*math.pi/2)
            cy,rx,ry=hair_profile(z)
            x=rx*math.sin(a)+.002*math.sin(t*math.pi)
            y=cy-ry*math.cos(a)
            vertices.append((x,y,z))
    for k in range(steps):
        for j in range(segments):
            a=k*segments+j;b=k*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    mesh('Sculpted swept hair',vertices,faces,HAIR,bone='Head',subdivision=1)
    # Fine comb ridges follow the cap surface with only a millimeter of relief.
    for i in range(6):
        start=-.75+i*.25;points=[]
        low=1.688+.086*max(0,math.cos(start))**2+.002*math.sin(start)+.003
        for k in range(7):
            t=k/6;a=start+.35*t;z=low+(1.820-low)*t
            cy,rx,ry=hair_profile(z)
            points.append(((rx+.0006)*math.sin(a),cy-(ry+.0006)*math.cos(a),z))
        tube(f'Subtle swept comb ridge {i+1}',points,.0009,HAIR_GLEAM,'Head')


def weld_garment(names, name, mat, weights_fn):
    """Union overlapping garment pieces, preserving a smooth skin weight field."""
    vertices=[]; faces=[]
    for part_name in names:
        obj=bpy.data.objects[part_name]
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active=obj;obj.select_set(True)
        for modifier in list(obj.modifiers):
            if modifier.type!='ARMATURE':bpy.ops.object.modifier_apply(modifier=modifier.name)
        offset=len(vertices)
        for vertex in obj.data.vertices:
            vertices.append(tuple(vertex.co))
        faces.extend(tuple(offset+i for i in face.vertices) for face in obj.data.polygons)
    data=bpy.data.meshes.new(name);data.from_pydata(vertices,[],faces);data.update()
    obj=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action='DESELECT');bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    modifier=obj.modifiers.new('Continuous tailored garment','REMESH');modifier.mode='VOXEL';modifier.voxel_size=.004;modifier.use_smooth_shade=True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    modifier=obj.modifiers.new('Relax the fabric surface','SMOOTH');modifier.factor=.55;modifier.iterations=5
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    modifier=obj.modifiers.new('Efficient browser garment','DECIMATE');modifier.ratio=.18
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    weights=[weights_fn(vertex.co) for vertex in obj.data.vertices]
    obj.data.materials.append(mat);smooth(obj);bind(obj,weights=weights)
    for part_name in names:bpy.data.objects.remove(bpy.data.objects[part_name],do_unlink=True)


def cache_original_skin(body):
    """Keep the CC0 artist's continuous anatomical weight field before dressing."""
    global SOURCE_SKIN_TREE, SOURCE_SKIN_WEIGHTS
    from mathutils.kdtree import KDTree
    SOURCE_SKIN_TREE=KDTree(len(body.data.vertices))
    SOURCE_SKIN_WEIGHTS=[]
    names={group.index:group.name for group in body.vertex_groups}
    for vertex in body.data.vertices:
        SOURCE_SKIN_TREE.insert(vertex.co,vertex.index)
        SOURCE_SKIN_WEIGHTS.append({names[g.group]:g.weight for g in vertex.groups})
    SOURCE_SKIN_TREE.balance()


def costume_weights(co):
    result={}
    for position,index,distance in SOURCE_SKIN_TREE.find_n(co,8):
        influence=1/(distance*distance+.0001)
        for name,weight in SOURCE_SKIN_WEIGHTS[index].items():
            result[name]=result.get(name,0)+weight*influence
    total=sum(result.values())
    return {name:weight/total for name,weight in result.items()}


def preserve_exported_rig(source, output):
    """Restore exact source GLTF transforms/bind matrices after Blender float roundoff."""
    def read(path):
        raw=path.read_bytes()
        json_size=struct.unpack_from('<I',raw,12)[0]
        data=json.loads(raw[20:20+json_size])
        binary_at=20+json_size
        binary_size=struct.unpack_from('<I',raw,binary_at)[0]
        return data,bytearray(raw[binary_at+8:binary_at+8+binary_size])
    original,source_binary=read(source)
    result,binary=read(output)
    original_nodes={node['name']:node for node in original['nodes'] if 'mesh' not in node}
    for node in result['nodes']:
        name=node.get('name')
        if name in original_nodes:
            for key in ('translation','rotation','scale','matrix'):
                node.pop(key,None)
                if key in original_nodes[name]:node[key]=original_nodes[name][key]
    source_skin=original['skins'][0]
    source_accessor=original['accessors'][source_skin['inverseBindMatrices']]
    source_view=original['bufferViews'][source_accessor['bufferView']]
    source_offset=source_view.get('byteOffset',0)+source_accessor.get('byteOffset',0)
    source_stride=source_view.get('byteStride',64)
    matrices={original['nodes'][node]['name']:source_binary[source_offset+i*source_stride:source_offset+i*source_stride+64] for i,node in enumerate(source_skin['joints'])}
    for skin in result['skins']:
        accessor=result['accessors'][skin['inverseBindMatrices']]
        view=result['bufferViews'][accessor['bufferView']]
        offset=view.get('byteOffset',0)+accessor.get('byteOffset',0)
        stride=view.get('byteStride',64)
        assert len(skin['joints'])==len(matrices)
        for i,node in enumerate(skin['joints']):
            binary[offset+i*stride:offset+i*stride+64]=matrices[result['nodes'][node]['name']]
    json_bytes=json.dumps(result,separators=(',',':'),ensure_ascii=False).encode('utf8')
    json_bytes+=b' '*((-len(json_bytes))%4)
    binary+=b'\0'*((-len(binary))%4)
    payload=struct.pack('<III',0x46546C67,2,28+len(json_bytes)+len(binary))+struct.pack('<II',len(json_bytes),0x4E4F534A)+json_bytes+struct.pack('<II',len(binary),0x004E4942)+binary
    output.write_bytes(payload)


def render_preview(path):
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=48
    scene.cycles.use_denoising=True
    scene.world=bpy.data.worlds.new('Studio world')
    scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.05,.06,.09,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
    # A comfortable standing pose for the asset still; export was already in rest pose.
    for side,sign in [('l',1),('r',-1)]:
        bone=RIG.pose.bones[f'upperarm_{side}']
        bone.rotation_mode='XYZ';bone.rotation_euler[0]=0
        # Local bone X is aligned approximately to the vertical plane of the T-pose.
        bone.rotation_euler[2]=-sign*math.radians(70)
    bpy.context.view_layer.update()
    floor=material('Studio floor',(.021,.025,.039),.72)
    bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.02));bpy.context.object.data.materials.append(floor)
    for name,loc,energy,size,color in [('Key',(-3,-4,5),450,4,(.87,.94,1)),('Fill',(3,-2,3),250,3,(1,.86,.73)),('Rim',(1,2,4),500,3,(.42,.65,1))]:
        data=bpy.data.lights.new(name,'AREA');data.energy=energy;data.shape='DISK';data.size=size;data.color=color
        obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=loc;obj.rotation_euler=(Vector((0,0,1))-obj.location).to_track_quat('-Z','Y').to_euler()
    data=bpy.data.cameras.new('Character portrait');cam=bpy.data.objects.new('Character portrait',data);scene.collection.objects.link(cam)
    cam.location=(.6,-4,2.1);cam.rotation_euler=(Vector((0,0,.99))-cam.location).to_track_quat('-Z','Y').to_euler();data.type='ORTHO';data.ortho_scale=2.16;scene.camera=cam
    scene.render.resolution_x=1100;scene.render.resolution_y=1300;scene.render.resolution_percentage=100
    scene.view_settings.view_transform='AgX'
    scene.render.filepath=str(path);path.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.render.render(write_still=True)


def main():
    global RIG,SKIN,SKIN_SHADOW,SKIN_LIP,BLUE,BLUE_DARK,BLACK,WHITE,LAPEL,SHOE,SOLE,GOLD,LIP,LENS,HAIR,HAIR_GLEAM
    args=arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.source))
    RIG=next(o for o in bpy.data.objects if o.type=='ARMATURE')
    reference={b.name:tuple(v for row in b.matrix_local for v in row) for b in RIG.data.bones}
    SKIN=material('Warm peach skin',(.62,.37,.24),.54)
    SKIN_SHADOW=material('Warm skin creases',(.32,.115,.072),.68)
    SKIN_LIP=material('Lower lip',(.56,.27,.19),.58)
    BLUE=material('Cobalt blue wool tuxedo',(.018,.145,.45),.60)
    BLUE_DARK=material('Blue pocket welt',(.024,.13,.38),.57)
    BLACK=material('Black tuxedo trousers',(.018,.022,.031),.64)
    WHITE=material('Ivory dress shirt',(.88,.91,.91),.50)
    LAPEL=material('Black satin lapels and frames',(.009,.013,.020),.27)
    SHOE=material('Polished black patent leather',(.008,.012,.019),.19,.12)
    SOLE=material('Black leather sole',(.006,.008,.012),.68)
    GOLD=material('Brushed silver hardware',(.62,.68,.70),.24,.8)
    LIP=material('Smile crease',(.22,.067,.046),.65)
    LENS=material('Smoky midnight sunglasses',(.012,.035,.051),.13,.22)
    HAIR=material('Soft black swept hair',(.008,.010,.014),.55)
    HAIR_GLEAM=material('Subtle hair ridges',(.010,.013,.018),.58)
    costume();face()
    weld_garment(['Blue dinner jacket','l tailored sleeve','r tailored sleeve'],'Continuous blue dinner jacket',BLUE,costume_weights)
    weld_garment(['Tuxedo waistband','l straight trouser leg','r straight trouser leg'],'Continuous tuxedo trousers',BLACK,costume_weights)
    assert reference=={b.name:tuple(v for row in b.matrix_local for v in row) for b in RIG.data.bones}, 'Rest skeleton changed'
    # Every visible detail is skinned, so the browser can clone and articulate it.
    for obj in bpy.data.objects:
        if obj.type=='MESH':
            assert any(m.type=='ARMATURE' and m.object==RIG for m in obj.modifiers),obj.name
    args.output.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=str(args.output),export_format='GLB',export_animations=False,export_skins=True,export_all_influences=False,export_apply=True,export_extras=True)
    preserve_exported_rig(args.source,args.output)
    print(f'Character exported: {args.output} ({args.output.stat().st_size:,} bytes), {len(reference)} unchanged bones',flush=True)
    if args.blend:
        args.blend.parent.mkdir(parents=True,exist_ok=True)
        bpy.context.preferences.filepaths.save_version=0
        bpy.ops.wm.save_as_mainfile(filepath=str(args.blend))
    if args.preview:render_preview(args.preview)

if __name__=='__main__':main()
