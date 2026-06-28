const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

export function validateAccountPassword(password) {
  if (typeof password !== 'string') {
    return 'Password is required';
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer`;
  }

  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) {
    return 'Password must include letters and at least one number or symbol';
  }

  return null;
}
