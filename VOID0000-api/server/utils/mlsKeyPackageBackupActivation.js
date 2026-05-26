const MAX_MLS_KEY_PACKAGE_REFS = 200;
const MAX_MLS_KEY_PACKAGE_REF_LENGTH = 255;

export function normalizeBackedUpMlsKeyPackageRefs(value) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > MAX_MLS_KEY_PACKAGE_REFS) {
    return null;
  }

  const refs = [];
  for (const valueRef of value) {
    if (typeof valueRef !== 'string') {
      return null;
    }

    const normalized = valueRef.trim();
    if (!normalized || normalized.length > MAX_MLS_KEY_PACKAGE_REF_LENGTH) {
      return null;
    }

    refs.push(normalized);
  }

  return [...new Set(refs)];
}

export async function activateBackedUpMlsKeyPackages(db, userId, packageRefs) {
  if (!packageRefs.length) {
    return [];
  }

  const result = await db.query(
    `UPDATE mls_key_packages
     SET claimable_at = COALESCE(claimable_at, NOW())
     WHERE user_id = $1::UUID
       AND package_ref = ANY($2::TEXT[])
       AND published_at IS NOT NULL
       AND consumed_at IS NULL
     RETURNING package_ref`,
    [userId, packageRefs]
  );

  return result.rows.map((row) => row.package_ref);
}
