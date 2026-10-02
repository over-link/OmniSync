// Extra preload for c5test.js: the pairing routes ask Revizto/ACC whether the person is a project admin of both
// projects (services/membership.projectAdminProblems). The test is about the one-ACC-project guard, not that
// check, so it answers "no problems". Everything else stays as in preload.js.
const path = require('path');
const membership = require(path.join(process.cwd(), 'src/services/membership'));
membership.projectAdminProblems = async () => [];
