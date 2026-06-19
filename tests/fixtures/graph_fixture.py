"""Build a self-contained Graph test database in pure Python, from the sibling dsm-samples schema.

The schema (Graph.dsm) is referenced from the sibling public repo `dsm-samples` (checked out next
to this repo). The database is created here -- no external .graph file is required.

  CLI:    python3 graph_fixture.py <output.graph>
  import: from graph_fixture import GRAPH_DSM, definitions_const, build
"""
import os
import sys
import dsviper

GRAPH_DSM = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "dsm-samples", "Ge", "Graph.dsm"))

VALUES = [1, 2, 2, 3, 5]
XS = [10.0, 20.0, 30.0, 40.0, 50.0]


def definitions_const():
    b = dsviper.DSMBuilder()
    b.append("Graph.dsm", open(GRAPH_DSM).read())
    _, _, dc = b.parse()
    return dc


def seed(db):
    insp = dsviper.DefinitionsInspector(db.definitions())
    vis = insp.check_attachment("Graph::Vertex.visualAttributes")
    v2d = insp.check_attachment("Graph::Vertex.render2DAttributes")
    topo = insp.check_attachment("Graph::Graph.topology")
    vks = [dsviper.ValueUUId.create() for _ in VALUES]
    gk = dsviper.ValueUUId.create()
    ms = dsviper.CommitMutableState(dsviper.CommitStateBuilder.initial_state(db))
    am = ms.attachment_mutating()
    for u, val, x in zip(vks, VALUES, XS):
        am.set(vis, vis.create_key(u), {"value": val, "color": {"red": val / 10.0, "green": 0.0, "blue": 0.0}})
        am.set(v2d, v2d.create_key(u), {"position": {"x": x, "y": 0.0}})
    am.set(topo, topo.create_key(gk), {"vertexKeys": [vis.create_key(u) for u in vks], "edgeKeys": []})
    db.commit_mutations("seed", ms)


def build(path):
    if os.path.exists(path):
        os.remove(path)
    db = dsviper.CommitDatabase.create(path)
    db.extend_definitions(definitions_const())
    seed(db)
    db.close()
    return path


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "scene.graph"
    build(out)
    print(f"built {out}")
