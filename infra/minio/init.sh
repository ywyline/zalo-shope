#!/bin/sh

set -eu

: "${MINIO_BOOTSTRAP_ROOT_USER:?MINIO_BOOTSTRAP_ROOT_USER is required}"
: "${MINIO_BOOTSTRAP_ROOT_PASSWORD:?MINIO_BOOTSTRAP_ROOT_PASSWORD is required}"
: "${CONTENT_STORAGE_BUCKET:?CONTENT_STORAGE_BUCKET is required}"
: "${CONTENT_STORAGE_ACCESS_KEY:?CONTENT_STORAGE_ACCESS_KEY is required}"
: "${CONTENT_STORAGE_SECRET_KEY:?CONTENT_STORAGE_SECRET_KEY is required}"
: "${EVIDENCE_STORAGE_BUCKET:?EVIDENCE_STORAGE_BUCKET is required}"
: "${EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY:?EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY is required}"
: "${EVIDENCE_STORAGE_UPLOAD_SECRET_KEY:?EVIDENCE_STORAGE_UPLOAD_SECRET_KEY is required}"
: "${EVIDENCE_STORAGE_READ_ACCESS_KEY:?EVIDENCE_STORAGE_READ_ACCESS_KEY is required}"
: "${EVIDENCE_STORAGE_READ_SECRET_KEY:?EVIDENCE_STORAGE_READ_SECRET_KEY is required}"
: "${EVIDENCE_STORAGE_DELETE_ACCESS_KEY:?EVIDENCE_STORAGE_DELETE_ACCESS_KEY is required}"
: "${EVIDENCE_STORAGE_DELETE_SECRET_KEY:?EVIDENCE_STORAGE_DELETE_SECRET_KEY is required}"
: "${TEST_CONTENT_STORAGE_ACCESS_KEY:?TEST_CONTENT_STORAGE_ACCESS_KEY is required}"
: "${TEST_CONTENT_STORAGE_SECRET_KEY:?TEST_CONTENT_STORAGE_SECRET_KEY is required}"
: "${TEST_EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY:?TEST_EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY is required}"
: "${TEST_EVIDENCE_STORAGE_UPLOAD_SECRET_KEY:?TEST_EVIDENCE_STORAGE_UPLOAD_SECRET_KEY is required}"
: "${TEST_EVIDENCE_STORAGE_READ_ACCESS_KEY:?TEST_EVIDENCE_STORAGE_READ_ACCESS_KEY is required}"
: "${TEST_EVIDENCE_STORAGE_READ_SECRET_KEY:?TEST_EVIDENCE_STORAGE_READ_SECRET_KEY is required}"
: "${TEST_EVIDENCE_STORAGE_DELETE_ACCESS_KEY:?TEST_EVIDENCE_STORAGE_DELETE_ACCESS_KEY is required}"
: "${TEST_EVIDENCE_STORAGE_DELETE_SECRET_KEY:?TEST_EVIDENCE_STORAGE_DELETE_SECRET_KEY is required}"

assert_distinct() {
  label="$1"
  shift
  while [ "$#" -gt 1 ]; do
    current="$1"
    shift
    for other in "$@"; do
      if [ "${current}" = "${other}" ]; then
        echo "MinIO bootstrap requires distinct ${label}" >&2
        exit 1
      fi
    done
  done
}

if [ "${CONTENT_STORAGE_BUCKET}" = "${EVIDENCE_STORAGE_BUCKET}" ]; then
  echo "Content and evidence buckets must be distinct" >&2
  exit 1
fi

if [ "${CONTENT_STORAGE_BUCKET}" != "zalo-shop-local" ] || [ "${EVIDENCE_STORAGE_BUCKET}" != "zalo-shop-evidence-local" ]; then
  echo "Local MinIO policies require the repository's fixed content and evidence bucket names" >&2
  exit 1
fi

for bucket in "${CONTENT_STORAGE_BUCKET}" "${EVIDENCE_STORAGE_BUCKET}"; do
  bucket_length="${#bucket}"
  case "${bucket}" in
    *[!a-z0-9.-]* | .* | -* | *. | *-) bucket_is_valid=false ;;
    *) bucket_is_valid=true ;;
  esac
  if [ "${bucket_length}" -lt 3 ] || [ "${bucket_length}" -gt 63 ] || [ "${bucket_is_valid}" != true ]; then
    echo "MinIO bootstrap bucket name is invalid" >&2
    exit 1
  fi
done

assert_distinct "access keys" \
  "${MINIO_BOOTSTRAP_ROOT_USER}" \
  "${CONTENT_STORAGE_ACCESS_KEY}" \
  "${EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY}" \
  "${EVIDENCE_STORAGE_READ_ACCESS_KEY}" \
  "${EVIDENCE_STORAGE_DELETE_ACCESS_KEY}" \
  "${TEST_CONTENT_STORAGE_ACCESS_KEY}" \
  "${TEST_EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY}" \
  "${TEST_EVIDENCE_STORAGE_READ_ACCESS_KEY}" \
  "${TEST_EVIDENCE_STORAGE_DELETE_ACCESS_KEY}"
assert_distinct "secret keys" \
  "${MINIO_BOOTSTRAP_ROOT_PASSWORD}" \
  "${CONTENT_STORAGE_SECRET_KEY}" \
  "${EVIDENCE_STORAGE_UPLOAD_SECRET_KEY}" \
  "${EVIDENCE_STORAGE_READ_SECRET_KEY}" \
  "${EVIDENCE_STORAGE_DELETE_SECRET_KEY}" \
  "${TEST_CONTENT_STORAGE_SECRET_KEY}" \
  "${TEST_EVIDENCE_STORAGE_UPLOAD_SECRET_KEY}" \
  "${TEST_EVIDENCE_STORAGE_READ_SECRET_KEY}" \
  "${TEST_EVIDENCE_STORAGE_DELETE_SECRET_KEY}"

mc alias set local http://minio:9000 "${MINIO_BOOTSTRAP_ROOT_USER}" "${MINIO_BOOTSTRAP_ROOT_PASSWORD}" >/dev/null

mc mb --ignore-existing "local/${CONTENT_STORAGE_BUCKET}" >/dev/null
mc mb --ignore-existing "local/${EVIDENCE_STORAGE_BUCKET}" >/dev/null
mc anonymous set none "local/${CONTENT_STORAGE_BUCKET}" >/dev/null
mc anonymous set none "local/${EVIDENCE_STORAGE_BUCKET}" >/dev/null

evidence_versioning="$(mc version info --json "local/${EVIDENCE_STORAGE_BUCKET}")"
case "${evidence_versioning}" in
  *'"versioning":{"status":""'*) ;;
  *)
    echo "Evidence bucket versioning must never have been enabled for delete-only D1 semantics" >&2
    exit 1
    ;;
esac

mc admin policy create local zalo-shop-content-local /policies/content.json >/dev/null
mc admin policy create local zalo-shop-evidence-upload-local /policies/evidence-upload.json >/dev/null
mc admin policy create local zalo-shop-evidence-read-local /policies/evidence-read.json >/dev/null
mc admin policy create local zalo-shop-evidence-delete-local /policies/evidence-delete.json >/dev/null

mc admin user add local "${CONTENT_STORAGE_ACCESS_KEY}" "${CONTENT_STORAGE_SECRET_KEY}" >/dev/null
mc admin user add local "${EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY}" "${EVIDENCE_STORAGE_UPLOAD_SECRET_KEY}" >/dev/null
mc admin user add local "${EVIDENCE_STORAGE_READ_ACCESS_KEY}" "${EVIDENCE_STORAGE_READ_SECRET_KEY}" >/dev/null
mc admin user add local "${EVIDENCE_STORAGE_DELETE_ACCESS_KEY}" "${EVIDENCE_STORAGE_DELETE_SECRET_KEY}" >/dev/null
mc admin user add local "${TEST_CONTENT_STORAGE_ACCESS_KEY}" "${TEST_CONTENT_STORAGE_SECRET_KEY}" >/dev/null
mc admin user add local "${TEST_EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY}" "${TEST_EVIDENCE_STORAGE_UPLOAD_SECRET_KEY}" >/dev/null
mc admin user add local "${TEST_EVIDENCE_STORAGE_READ_ACCESS_KEY}" "${TEST_EVIDENCE_STORAGE_READ_SECRET_KEY}" >/dev/null
mc admin user add local "${TEST_EVIDENCE_STORAGE_DELETE_ACCESS_KEY}" "${TEST_EVIDENCE_STORAGE_DELETE_SECRET_KEY}" >/dev/null

mc admin policy attach local zalo-shop-content-local --user "${CONTENT_STORAGE_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-evidence-upload-local --user "${EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-evidence-read-local --user "${EVIDENCE_STORAGE_READ_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-evidence-delete-local --user "${EVIDENCE_STORAGE_DELETE_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-content-local --user "${TEST_CONTENT_STORAGE_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-evidence-upload-local --user "${TEST_EVIDENCE_STORAGE_UPLOAD_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-evidence-read-local --user "${TEST_EVIDENCE_STORAGE_READ_ACCESS_KEY}" >/dev/null
mc admin policy attach local zalo-shop-evidence-delete-local --user "${TEST_EVIDENCE_STORAGE_DELETE_ACCESS_KEY}" >/dev/null
