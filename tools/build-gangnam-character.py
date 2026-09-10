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


def tube(name, points, radius, mat, bone, resolution=6, bevel_resolution=2, handles='AUTO'):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = resolution
    curve.bevel_depth = radius
    curve.bevel_resolution = bevel_resolution
    spline = curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for p, coordinate in zip(spline.bezier_points, points):
        p.co = coordinate
        p.handle_left_type = handles
        p.handle_right_type = handles
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target='MESH')
    obj = bpy.context.object
    obj.data.materials.append(mat)
    obj.select_set(False)
    return bind(obj, weights=[costume_weights(v.co) for v in obj.data.vertices] if bone.startswith('spine_') else None, bone=None if bone.startswith('spine_') else bone)


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
    if name=='Blue dinner jacket':
        rings=[(z,x,y,rx*(1-.06*max(0,min(1,(z-1.20)/.26))),ry) for z,x,y,rx,ry in rings]
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
    satin=material('Blue shawl lapel fabric',(.14,.265,.47),.56)
    satin.node_tree.nodes['Principled BSDF'].inputs['Specular IOR Level'].default_value=.23
    # A stocky fitted silhouette and continuous inner sleeve roots.
    loft('Blue dinner jacket', [
        (.965,0,.027,.207,.140),(.974,0,.026,.214,.145),
        (1.04,0,.008,.228,.163),(1.14,0,.004,.233,.171),
        (1.24,0,.008,.225,.164),(1.34,0,.020,.231,.154),
        (1.42,0,.033,.238,.131),(1.48,0,.043,.228,.108),
        (1.512,0,.041,.170,.080),(1.532,0,.040,.075,.055)
    ], BLUE, weights_fn=torso_weights)
    # Black high-waisted trousers and naturally draped legs.
    loft('Tuxedo waistband',[(.883,0,.028,.190,.124),(.95,0,.022,.206,.137),(1.016,0,.018,.206,.138)],BLACK,weights_fn=lambda z:{'pelvis':1})
    for side,sign in [('l',1),('r',-1)]:
        def leg_weights(z,side=side):
            if z > .65: return {f'thigh_{side}':1}
            if z < .43: return {f'calf_{side}':1}
            t=(z-.43)/.22
            return {f'calf_{side}':1-t,f'thigh_{side}':t}
        loft(f'{side} straight trouser leg',[(.071,sign*.114,.066,.065,.066),(.079,sign*.114,.068,.066,.067),(.15,sign*.114,.073,.066,.068),(.27,sign*.114,.060,.063,.067),(.45,sign*.114,.040,.065,.072),(.56,sign*.114,.033,.075,.083),(.69,sign*.114,.036,.092,.103),(.84,sign*.100,.031,.105,.115),(.95,sign*.090,.025,.108,.115)],BLACK,weights_fn=leg_weights)
        # Patent loafers, toe box, and low black sole.
        ellipsoid(f'{side} patent loafer',(sign*.114,-.033,.065),(.070,.149,.063),SHOE,f'foot_{side}')
        ellipsoid(f'{side} sole',(sign*.114,-.034,.015),(.071,.148,.018),SOLE,f'foot_{side}')
        tube(f'{side} loafer vamp',[(sign*.114-.053,-.05,.091),(sign*.114,-.059,.108),(sign*.114+.053,-.05,.091)],.005,BLACK,f'foot_{side}')
        def arm_weights(x,side=side):
            t=max(0,min(1,(abs(x)-.41)/.105))
            return {f'upperarm_{side}':1-t,f'lowerarm_{side}':t}
        rings=[(.100,.052,1.475,.035,.032),(.155,.055,1.463,.071,.066),(.215,.061,1.455,.089,.083),(.27,.064,1.455,.087,.081),(.34,.069,1.455,.079,.074),(.44,.072,1.455,.066,.065),(.49,.071,1.455,.063,.060),(.59,.067,1.455,.055,.052),(.675,.065,1.455,.044,.042),(.687,.065,1.455,.044,.042)]
        rings=[(x,y,z,r1*(.90+.10*max(0,min(1,(x-.34)/.22))),r2*(.90+.10*max(0,min(1,(x-.34)/.22)))) for x,y,z,r1,r2 in rings]
        if sign<0: rings=[(-x,y,z,r1,r2) for x,y,z,r1,r2 in reversed(rings)]
        loft(f'{side} tailored sleeve',rings,BLUE,direction='x',weights_fn=arm_weights)
        cuff=[(sign*x,.065,1.455,.041,.040) for x in (.684,.687,.709,.711)]
        if sign<0:cuff.reverse()
        loft(f'{side} white shirt cuff',cuff,WHITE,direction='x',weights_fn=lambda x,side=side:{f'lowerarm_{side}':1})
        trim=[(sign*x,.065,1.455,.045,.043) for x in (.679,.681,.686,.688)]
        if sign<0:trim.reverse()
        loft(f'{side} black cuff piping',trim,LAPEL,direction='x',weights_fn=lambda x,side=side:{f'lowerarm_{side}':1})
        ellipsoid(f'{side} cufflink',(sign*.699,.026,1.455),(.005,.0025,.006),GOLD,f'lowerarm_{side}',16,10)
    ellipsoid('Neck',(0,.035,1.546),(.068,.064,.068),SKIN,'neck_01')
    # Pleated shirt and blue shawl lapels, shaped to the jacket front.
    # Conform shirt and lapels to the round torso; a flat panel would cut through it.
    def front_y(x, z):
        anchors=[(.974,.026,.214,.145),(1.04,.008,.228,.163),(1.14,.004,.233,.171),(1.24,.008,.225,.164),(1.34,.020,.231,.154),(1.42,.033,.238,.131),(1.48,.043,.228,.108),(1.512,.041,.170,.080),(1.532,.040,.075,.055)]
        for a,b in zip(anchors,anchors[1:]):
            if a[0] <= z <= b[0]:
                t=(z-a[0])/(b[0]-a[0]); cy=a[1]*(1-t)+b[1]*t;rx=a[2]*(1-t)+b[2]*t;ry=a[3]*(1-t)+b[3]*t
                rx*=1-.06*max(0,min(1,(z-1.20)/.26))
                return cy-ry*math.sqrt(max(.05,1-(x/rx)**2))-.007
        _,cy,rx,ry=anchors[-1 if z>anchors[-1][0] else 0]
        return cy-ry*math.sqrt(max(.05,1-(x/rx)**2))-.007
    vertices=[]; faces=[]
    shirt_rows=[(1.22,.006),(1.26,.020),(1.31,.059),(1.365,.089),(1.41,.111),(1.46,.099),(1.49,.075),(1.528,.052)]
    for z,width in shirt_rows:
        for j in range(33):
            x=width*(j/16-1);fold=.0018*math.cos(x*TAU/.018)
            vertices.append((x,front_y(x,z)-fold,z))
    for i in range(len(shirt_rows)-1):
        for j in range(32):
            a=i*33+j;faces.append((a,a+1,a+34,a+33))
    mesh('White shirt front',vertices,faces,WHITE,weights=[costume_weights(Vector(p)) for p in vertices])
    fold_mat=material('Soft shadow in shirt pleats',(.76,.80,.81),.66)
    for i in range(-4,5):
        x=i*.0135
        z0=1.32+abs(x)*1.1
        points=[(x,front_y(x,z)-.0025,z) for z in (z0,(z0+1.485)/2,1.485)]
        tube(f'White shirt pleat {i}',points,.00055,fold_mat,'spine_03',resolution=3,bevel_resolution=1)
    for sign in (-1,1):
        def mirrored(points):return [(sign*x, min(y,front_y(x,z)-.004),z) for x,y,z in points]
        # A fitted quad ribbon follows the chest with a continuous shawl curve.
        # A single nonplanar polygon produces long, visibly angular triangles.
        rows=[(1.525,.055,.077),(1.497,.070,.103),(1.466,.091,.130),(1.430,.105,.146),(1.409,.102,.145),(1.365,.080,.134),(1.315,.047,.107),(1.260,.010,.058),(1.220,.001,.025)]
        lapel_vertices=[];lapel_faces=[]
        for z,inner,outer in rows:
            for j in range(7):
                t=j/6;x=inner+(outer-inner)*t
                lapel_vertices.append((sign*x,front_y(x,z)-.004-.002*math.sin(t*math.pi),z))
        for i in range(len(rows)-1):
            for j in range(6):
                a=i*7+j;lapel_faces.append((a,a+1,a+8,a+7))
        lapel=mesh(f'{sign} blue shawl lapel',lapel_vertices,lapel_faces,satin,weights=[costume_weights(Vector(p)) for p in lapel_vertices],subdivision=1)
        modifier=lapel.modifiers.new('Lapel fabric edge','SOLIDIFY');modifier.thickness=.002
        piping=[(sign*outer,front_y(outer,z)-.008,z) for z,inner,outer in rows]
        tube(f'{sign} black shawl lapel piping',piping,.0027,LAPEL,'spine_03')
        panel(f'{sign} shirt collar',mirrored([(.012,-.042,1.534),(.059,-.044,1.527),(.064,-.077,1.483),(.029,-.083,1.497)]),WHITE)
        # A gently folded bow tie, not flat triangles.
        points=mirrored([(.009,-.094,1.489),(.047,-.089,1.509),(.051,-.089,1.466),(.009,-.094,1.477)])
        points=[(x*1.32,y-.002,1.492+(z-1.488)*1.18) for x,y,z in points]
        panel(f'{sign} bow tie wing',points,LAPEL,thickness=.006,bevel=.0025)
        # Piped blue flaps define the jacket from the music video.
        pocket=[(.105,1.137),(.183,1.153),(.183,1.121),(.105,1.105)]
        pp=[(sign*x,front_y(x,z)-.005,z) for x,z in pocket]
        panel(f'{sign} blue piped pocket flap',pp,BLUE,'spine_01')
        tube(f'{sign} black pocket piping',pp[1:]+pp[:1],.0028,LAPEL,'spine_01',handles='VECTOR')
    ellipsoid('Bow tie knot',(0,-.103,1.492),(.012,.008,.015),LAPEL,'spine_03',24,16)
    for z in (1.19,1.075):
        ellipsoid('Jacket button',(0,front_y(0,z)-.006,z),(.011,.005,.011),LAPEL,'spine_01' if z<1.1 else 'spine_02',20,12)
    # The MV jacket has clean shawl lapels and piped lower pockets, no pocket square.


def face():
    """A continuous, hand-shaped adult facial surface on the unchanged head bone.

    The 2012 reference has a broad midface, a compact jaw, restrained lips, and
    small rounded lenses. Features are displaced into one surface instead of
    assembled from nose/cheek balls, so the profile and three-quarter view agree.
    """
    profile=[(1.565,.017,.035,.040),(1.578,.015,.055,.065),
        (1.593,.015,.073,.081),(1.613,.015,.089,.091),
        (1.638,.020,.106,.098),(1.663,.023,.108,.101),
        (1.688,.027,.103,.098),(1.713,.030,.098,.095),
        (1.740,.032,.096,.091),(1.764,.033,.092,.085),
        (1.789,.035,.083,.077),(1.808,.036,.065,.060),
        (1.823,.037,.026,.026),(1.826,.037,.001,.001)]
    def proportions(z):
        for n,(a,b) in enumerate(zip(profile,profile[1:])):
            if a[0] <= z <= b[0]:
                before=profile[max(0,n-1)];after=profile[min(len(profile)-1,n+2)]
                h=b[0]-a[0];t=(z-a[0])/h;values=[]
                for j in (1,2,3):
                    m0=(b[j]-before[j])/(b[0]-before[0])
                    m1=(after[j]-a[j])/(after[0]-a[0])
                    values.append((2*t**3-3*t*t+1)*a[j]+(t**3-2*t*t+t)*h*m0+(-2*t**3+3*t*t)*b[j]+(t**3-t*t)*h*m1)
                return tuple(values)
        return profile[0 if z<profile[0][0] else -1][1:]
    def gauss(x,z,cx,cz,sx,sz):return math.exp(-((x-cx)/sx)**2-((z-cz)/sz)**2)
    def sculpt(x,z):
        # Broad, subtle cheek planes; a real bridge and blended nasal alae.
        d=.0075*(gauss(x,z,-.054,1.662,.033,.031)+gauss(x,z,.054,1.662,.033,.031))
        d+=.012*gauss(x,z,0,1.687,.019,.040)
        d+=.009*gauss(x,z,0,1.667,.022,.030)
        d+=.0035*(gauss(x,z,-.019,1.667,.014,.017)+gauss(x,z,.019,1.667,.014,.017))
        d+=.009*gauss(x,z,0,1.628,.040,.025)
        d+=.006*gauss(x,z,0,1.592,.036,.017)
        d-=.006*(gauss(x,z,-.040,1.706,.025,.015)+gauss(x,z,.040,1.706,.025,.015))
        d-=.0025*(gauss(x,z,-.034,1.642,.008,.018)+gauss(x,z,.034,1.642,.008,.018))
        return d
    def face_y(x,z):
        cy,rx,ry=proportions(z);c=math.sqrt(max(0,1-(x/rx)**2))
        return cy-ry*c-sculpt(x,z)*c**3
    verts=[];faces=[];segments=96;rows=80
    for k in range(rows+1):
        z=profile[0][0]+(profile[-1][0]-profile[0][0])*k/rows
        cy,rx,ry=proportions(z)
        for j in range(segments):
            a=TAU*j/segments;c=math.cos(a);x=rx*math.sin(a)
            verts.append((x,cy-ry*c-sculpt(x,z)*max(0,c)**3,z))
    for k in range(rows):
        for j in range(segments):
            a=k*segments+j;b=k*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    faces.extend([tuple(reversed(range(segments))),tuple(rows*segments+j for j in range(segments))])
    verts=[(x,y,1.755+(z-1.755)*.65 if z>1.755 else z) for x,y,z in verts]
    mesh('Continuous sculpted face and nose',verts,faces,SKIN,bone='Head',subdivision=1)
    for sign in (-1,1):
        ellipsoid(f'{sign} ear',(sign*.101,.027,1.697),(.014,.022,.031),SKIN,'Head')
        ellipsoid(f'{sign} ear concha',(sign*.111,.014,1.697),(.003,.010,.014),SKIN_SHADOW,'Head',24,16)
        # The bridge and alae are part of the face mesh; avoid attached nostril dots.
    # Restrained lip surfaces share the muzzle contour around a narrow opening.
    width=.032
    def mouth_z(x):return 1.624+.0005*(abs(x)/width)**1.6
    for upper in (True,False):
        vs=[];fs=[]
        for i in range(49):
            x=width*(i/24-1);fall=max(0,1-(x/width)**2)**.65
            height=(.0048 if upper else .006)*fall
            if upper:height*=.78+.22*abs(math.sin(x/width*math.pi))
            for j in range(5):
                t=j/4;z=mouth_z(x)+(1 if upper else -1)*(.0023*fall+height*t)
                vs.append((x,face_y(x,z)-.0005-.0022*math.sin(t*math.pi)*fall,z))
        for i in range(48):
            for j in range(4):
                a=i*5+j;fs.append((a,a+1,a+6,a+5))
        mesh('Upper lip' if upper else 'Lower lip',vs,fs,SKIN_LIP,bone='Head',subdivision=1)
    # A small recessed-looking opening, with a restrained fuller lower lip.
    vs=[(0,face_y(0,1.624)-.0007,1.624)];fs=[]
    for i in range(48):
        a=TAU*i/48;x=width*math.cos(a);z=mouth_z(x)+.0024*math.sin(a)
        vs.append((x,face_y(x,z)-.0007,z))
    for i in range(48):fs.append((0,i+1,(i+1)%48+1))
    mesh('Slightly parted natural mouth',vs,fs,LIP,bone='Head')
    # A restrained inner brow angle is visible above the sunglass top edge.
    for sign in (-1,1):
        points=[]
        for i in range(9):
            x=sign*(.016+i*.0046);z=1.735+.004*math.sin(i/8*math.pi*.8)
            points.append((x,face_y(x,z)-.0014,z))
        tube(f'{sign} brow above sunglasses',points,.0012,HAIR,'Head',resolution=3,bevel_resolution=1)
    # Compact rounded black sunglasses as in the blue-jacket MV reference.
    # A domed lens and wrapped rim sit on the bridge, exposing the cheeks.
    def lens_outline(sign,factor=1):
        points=[]
        for i in range(64):
            a=TAU*i/64;c=math.cos(a);s=math.sin(a)
            x=sign*(.042+.0355*factor*math.copysign(abs(c)**.82,c))
            z=1.711+factor*(.0185*abs(s)**.40 if s>=0 else -.0255*abs(s)**.84)+.001*c
            y=-.098+1.65*x*x
            points.append((x,y,z))
        return points
    for sign in (-1,1):
        outline=lens_outline(sign)
        tube(f'{sign} rounded sunglass rim',outline+[outline[0]],.0031,LAPEL,'Head',resolution=2)
        center=(sign*.042,-.098+1.65*.042**2-.002,1.711)
        vs=[center];fs=[]
        for ring in range(1,9):
            t=ring/8
            for x,y,z in lens_outline(sign,.97):
                xx=center[0]+(x-center[0])*t;zz=center[2]+(z-center[2])*t
                vs.append((xx,-.098+1.65*xx*xx-.002*(1-t*t),zz))
        for j in range(64):fs.append((0,1+j,1+(j+1)%64))
        for ring in range(1,8):
            for j in range(64):
                a=1+(ring-1)*64+j;b=1+(ring-1)*64+(j+1)%64
                fs.append((a,b,b+64,a+64))
        mesh(f'{sign} curved dark lens',vs,fs,LENS,bone='Head')
        tube(f'{sign} slim sunglass temple',[(sign*.078,-.087,1.724),(sign*.097,-.035,1.721),(sign*.102,.023,1.710),(sign*.097,.036,1.692)],.0027,LAPEL,'Head')
        ellipsoid(f'{sign} silver hinge',(sign*.078,-.087,1.724),(.002,.0013,.0013),GOLD,'Head',16,10)
    tube('Arched sunglass bridge',[(-.009,-.099,1.717),(0,-.104,1.721),(.009,-.099,1.717)],.0026,LAPEL,'Head')
    swept_hair()


def swept_hair():
    """A smooth asymmetric brushed-back crown; restrained fine comb relief."""
    vertices=[];faces=[];segments=96;steps=28
    top=1.825
    def hairline(a):
        c=max(0,math.cos(a))
        return 1.686+.084*c**.31+.002*math.sin(a)
    def surface(a,z):
        q=max(0,min(1,(z-1.744)/(top-1.744)))
        r=math.sqrt(max(0,1-q*q))
        rx=.102*r;ry=.094*r;cy=.033+.019*q
        # Swept front volume leads into a rounded crown, short behind the ears.
        bump=.0035*math.exp(-((a+.42)/.7)**2-((z-1.791)/.029)**2)
        x=rx*math.sin(a)-.0035*math.sin(q*math.pi)
        y=cy-(ry+bump)*math.cos(a)
        return (x,y,z+bump*.35)
    for k in range(steps+1):
        t=k/steps
        for j in range(segments):
            a=TAU*j/segments;bottom=hairline(a)
            z=bottom+(top-bottom)*math.sin(t*math.pi/2)
            vertices.append(surface(a,z))
    for k in range(steps):
        for j in range(segments):
            a=k*segments+j;b=k*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    mesh('Swept quiff and short sides',vertices,faces,HAIR,bone='Head',subdivision=1)
    # Broad S-shaped comb paths sweep across the front toward the side part.
    # Relief is subtle and the paths finish at varying heights, avoiding a cap seam.
    for i in range(17):
        a0=-1.34+i*.108;points=[];low=hairline(a0)+.0007
        high=1.809+.005*math.sin(i*.65)
        for k in range(11):
            t=k/10;a=a0+.73*math.sin(t*math.pi/2);z=low+(high-low)*t
            x,y,zz=surface(a,z);points.append((x,y-.0003*math.cos(a),zz+.00015))
        tube(f'Swept comb relief {i:02}',points,.0003,HAIR_GLEAM,'Head',resolution=3,bevel_resolution=1)
    pts=[]
    for k in range(10):
        t=k/9;a=.43+.70*t;z=hairline(.43)+.001+(1.810-hairline(.43))*t
        x,y,zz=surface(a,z);pts.append((x,y-.0004*math.cos(a),zz+.0002))
    tube('Short side part',pts,.00065,HAIR_PART,'Head',resolution=3,bevel_resolution=1)


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
    modifier=obj.modifiers.new('Relax the fabric surface','SMOOTH');modifier.factor=.6;modifier.iterations=12
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
    for position,index,distance in SOURCE_SKIN_TREE.find_n(co,24):
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
    global RIG,SKIN,SKIN_SHADOW,SKIN_LIP,BLUE,BLUE_DARK,BLACK,WHITE,LAPEL,SHOE,SOLE,GOLD,LIP,LENS,HAIR,HAIR_GLEAM,HAIR_PART
    args=arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.source))
    RIG=next(o for o in bpy.data.objects if o.type=='ARMATURE')
    reference={b.name:tuple(v for row in b.matrix_local for v in row) for b in RIG.data.bones}
    SKIN=material('Warm peach skin',(.64,.425,.29),.56)
    SKIN.node_tree.nodes['Principled BSDF'].inputs['Subsurface Weight'].default_value=.06
    SKIN_SHADOW=material('Warm skin creases',(.37,.205,.145),.68)
    SKIN_LIP=material('Natural restrained lips',(.51,.265,.19),.62)
    BLUE=material('Muted periwinkle blue wool tuxedo',(.13,.235,.41),.64)
    BLUE_DARK=material('Black pocket piping',(.015,.018,.025),.56)
    BLACK=material('Black tuxedo trousers',(.018,.022,.031),.64)
    WHITE=material('Ivory dress shirt',(.88,.91,.91),.50)
    LAPEL=material('Black satin lapels and frames',(.009,.013,.020),.27)
    SHOE=material('Polished black patent leather',(.008,.012,.019),.19,.12)
    SOLE=material('Black leather sole',(.006,.008,.012),.68)
    GOLD=material('Brushed silver hardware',(.62,.68,.70),.24,.8)
    LIP=material('Subtle lip seam',(.30,.135,.092),.65)
    LENS=material('Dark neutral sunglass lenses',(.006,.009,.012),.39,0)
    LENS.node_tree.nodes['Principled BSDF'].inputs['Specular IOR Level'].default_value=.10
    HAIR=material('Soft black swept hair',(.008,.010,.014),.55)
    HAIR_GLEAM=material('Subtle hair ridges',(.009,.011,.015),.55)
    HAIR_PART=material('Hair side part shadow',(.003,.004,.006),.63)
    costume();face()
    # Compact neck-to-jaw relation of the adult reference, without moving bones.
    for obj in bpy.data.objects:
        if obj.type=='MESH' and obj.vertex_groups.get('Head') and len(obj.vertex_groups)==1:
            for vertex in obj.data.vertices:
                vertex.co.z-=.027
                vertex.co.x*=.86
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
