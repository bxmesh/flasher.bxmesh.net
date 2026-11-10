# CLAUDE.md — bxmesh/flasher.bxmesh.net

The MeshCore repeater flasher at flasher.bxmesh.net: a page that flashes and sets up a ProMicro
nRF52840 repeater over Web Serial, and its small server. Read
[`zindello-cluster/cluster-docs`](https://github.com/zindello-cluster/cluster-docs) before doing
anything here: its `CLAUDE.md`, the spec (`spec/design.md`), the binding layout (`spec/layout.md`)
and the rules (`spec/rules.md`). The rules apply here in full: an agent prepares a pull request and
never merges it or syncs in Argo. BxMesh never deploys itself (O14). Never write to a real serial
port or USB device: the tests use fakes.
