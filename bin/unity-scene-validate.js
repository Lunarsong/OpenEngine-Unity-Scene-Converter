#!/usr/bin/env node
'use strict';
// CLI entry: `unity-scene-validate <output.scene> <source.unity>`.
// src/validate.js reads process.argv[2..3] directly, which line up 1:1 here.
require('../src/validate.js');
