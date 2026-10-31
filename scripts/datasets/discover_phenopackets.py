import urllib.request
import ssl
import json

ctx = ssl._create_unverified_context()

def explore_repo(owner_repo, path=""):
    url = f"https://api.github.com/repos/{owner_repo}/contents/{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "GenoChain-Researcher/1.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data
    except Exception as e:
        print(f"Error {owner_repo}/{path}: {e}")
        return []

print("Exploring GA4GH / Phenopackets:")
schema_contents = explore_repo("phenopackets/phenopacket-schema", "src/test/resources")
if isinstance(schema_contents, list):
    print("phenopacket-schema/src/test/resources:", [f["name"] for f in schema_contents])

store_contents = explore_repo("monarch-initiative/phenopacket-store", "")
if isinstance(store_contents, list):
    print("phenopacket-store root:", [f["name"] for f in store_contents])

store_data = explore_repo("monarch-initiative/phenopacket-store", "data")
if isinstance(store_data, list):
    print("phenopacket-store/data:", [f["name"] for f in store_data])
