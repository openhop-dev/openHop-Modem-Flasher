function releaseParts(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '');
  return match?.slice(1).map(Number) ?? null;
}

export function releaseTagAtLeast(candidate, minimum) {
  if(!minimum) return true;

  const candidateParts = releaseParts(candidate);
  const minimumParts = releaseParts(minimum);
  if(!candidateParts || !minimumParts) return false;

  for(let index = 0; index < candidateParts.length; index++) {
    if(candidateParts[index] > minimumParts[index]) return true;
    if(candidateParts[index] < minimumParts[index]) return false;
  }

  return true;
}
