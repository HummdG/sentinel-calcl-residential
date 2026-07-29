// Display formatters ported from assets/js/sentinel-frontend.js (sf, sfmtYrs).

export function sf(n: number): string {
  return '£' + Math.round(n).toLocaleString('en-GB');
}

export function sfmtYrs(y: number): string {
  if (y <= 0) return 'N/A';
  let yr = Math.floor(y);
  let mo = Math.round((y - yr) * 12);
  if (mo === 12) {
    yr += 1;
    mo = 0;
  }
  if (yr === 0) return mo + ' mths';
  if (mo === 0) return yr + ' yrs';
  return yr + ' yrs ' + mo + ' mths';
}
