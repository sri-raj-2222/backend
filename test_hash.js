const bcrypt = require('bcryptjs');
const password = 'Admin@123';
const salt = bcrypt.genSaltSync(10);
const hash = bcrypt.hashSync(password, salt);
console.log('New Hash for Admin@123:', hash);

const existingHash = '$2b$10$LYYN29oBaztOEKpKWyb.JegXXbQaoo.GRXep.SOGL8tCMDzdb6F5C';
console.log('Match with existing:', bcrypt.compareSync(password, existingHash));
