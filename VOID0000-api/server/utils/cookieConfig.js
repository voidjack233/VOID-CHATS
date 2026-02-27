// Cookie maxAge constants
const ACCESS_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;  // 30 days (same as refresh — JWT expiresIn handles actual expiry)
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;  // 30 days

export const getCookieOptions = (maxAge = null) => {
  const isProd = process.env.NODE_ENV === 'production';

  const options = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/',
  };

  if (isProd) {
    options.domain = '.void0000.online';
  }

  if (maxAge) {
    options.maxAge = maxAge;
  }

  return options;
};

// Named helpers — use these instead of passing raw numbers
export const accessCookieOptions = () => getCookieOptions(ACCESS_COOKIE_MAX_AGE);
export const refreshCookieOptions = () => getCookieOptions(REFRESH_COOKIE_MAX_AGE);
export const clearCookieOptions = () => getCookieOptions();