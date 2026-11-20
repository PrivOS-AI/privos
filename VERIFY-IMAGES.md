# Verify the PrivOS container images (cosign)

Every `ghcr.io/privos-ai/*` image a self-hosted release pins is signed with the
PrivOS cosign key, and each platform image (`linux/amd64`, `linux/arm64`) carries a
CycloneDX SBOM attestation. Third-party images (mongo, redis, rustfs, weaviate) are not
signed by PrivOS; they are pinned by digest in the minisign-signed `versions.json`.

`install.sh` does not run these checks. Its trust chain is the minisign-signed
`versions.json`, which pins every image digest and the sha256 of `cosign.pub`. Run the
commands below when you want to check the images yourself. You need
[cosign](https://github.com/sigstore/cosign) v2, `jq` and `docker buildx`.

```bash
TAG=self-hosted-v7.15.x-tenant.N       # the release you install
BASE=https://github.com/PrivOS-AI/privos/releases/download/$TAG

# 1. Get the public key and check its fingerprint out of band (SIGNING.md on GitHub).
curl -fsSLO "$BASE/cosign.pub"
sha256sum cosign.pub
# expect: cf0266cb56f5dad90147a5feaad7a5a423718461d4ccc48017af95c4480d46c5  cosign.pub

# 2. Get the pinned digests. install.sh minisign-verifies versions.json; if you skip the
#    installer, verify it yourself: minisign -Vm versions.json -P <key from SIGNING.md>
curl -fsSLO "$BASE/versions.json"
jq -r '.images | to_entries[] | select(.value.repository | startswith("ghcr.io/privos-ai/"))
       | "\(.value.repository)@\(.value.digest)"' versions.json > privos-images.txt

# 3. Verify each image signature. No transparency log is used, so the flag is required.
while read -r ref; do
  cosign verify --key cosign.pub --insecure-ignore-tlog=true "$ref" >/dev/null && echo "OK  $ref"
done < privos-images.txt

# 4. Verify the SBOM attestation of the image your host runs, and extract the SBOM.
REF=ghcr.io/privos-ai/privos-hub@sha256:<index digest from step 2>
CHILD=$(docker buildx imagetools inspect "$REF" --raw |
  jq -r '.manifests[] | select(.platform.os=="linux" and .platform.architecture=="amd64") | .digest')
cosign verify-attestation --key cosign.pub --insecure-ignore-tlog=true --type cyclonedx \
  "ghcr.io/privos-ai/privos-hub@$CHILD" | jq -r .payload | base64 -d | jq .predicate > hub-sbom.cdx.json

# 5. Optional: the attested SBOM equals the Release asset (<name>-<os>-<arch>.cdx.json,
#    <name> is the versions.json images key, e.g. hub, sandboxBoard, appCluster).
curl -fsSLO "$BASE/hub-linux-amd64.cdx.json"
diff <(jq -S . hub-sbom.cdx.json) <(jq -S . hub-linux-amd64.cdx.json) && echo "SBOM matches"
```

Releases published before image signing went live carry no cosign signature; step 3
fails for them.
