'use strict';
module.exports = {
  ...require('./storeMigration'),
  ...require('./relocate'),
  ...require('./load'),
};
