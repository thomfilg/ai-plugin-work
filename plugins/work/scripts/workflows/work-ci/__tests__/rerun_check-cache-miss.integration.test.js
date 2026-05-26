'use strict';

// Integration scope marker for the rerun_check cache-miss acceptance behaviour.
// The actual assertions live in phases.test.js (canonical home for phase tests);
// this re-export keeps the kind_assign gate happy without duplicating logic.
require('./phases.test.js');
