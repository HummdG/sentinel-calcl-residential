<?php
// Generates golden calculator outputs from the ORIGINAL WordPress PHP calculator
// so the TypeScript port can be asserted against them. Run from the plugin root:
//   php web/test/php-golden.php > web/test/golden.json

define('ABSPATH', __DIR__);
require __DIR__ . '/../../includes/class-calculator.php';

// Default constants, mirroring Sentinel_Settings_Page::get_constants() defaults
// (pence values already converted to pounds).
$constants = [
    'peak_shaving_per_kwh'  => 47.0,
    'trading_per_kwh'       => 13.0,
    'iep_fee'               => 0.20,
    'sentinel_fee'          => 0.20,
    'sub'                   => 199.0,
    'export_base_standard'  => 0.055,
    'export_sentinel_flux'  => 0.22,
    'flux_charge_rate'      => 0.07,
    'mw' => [0.0348,0.0487,0.0810,0.1052,0.1288,0.1328,0.1335,0.1170,0.0886,0.0626,0.0382,0.0294],
    'tm' => ['standard' => 1.0, 'daynight' => 1.20, 'flux' => 1.40],
    'um' => ['daytime' => 0.75, 'balanced' => 1.0, 'evening' => 1.2],
    'bill_up' => ['standard' => 0.08, 'daynight' => 0.14, 'flux' => 0.17],
];

$calc = new Sentinel_Calculator($constants);

// A spread of scenarios: defaults, each tariff, each usage, os_roi set, flux
// arbitrage (export > gen), and a zero-battery edge case.
$base = [
    'pv_size' => 14.62, 'battery_kwh' => 10, 'inverter_kw' => 5,
    'annual_gen' => 13081, 'annual_usage' => 4500, 'system_cost' => 23867,
    'solar_savings' => 3733, 'export_kwh' => 8449, 'os_payback' => 5.83,
    'os_25yr' => 241633, 'os_roi' => 0,
    'std_import' => 28, 'dn_day' => 28, 'dn_night' => 15,
    'tariff' => 'standard', 'usage' => 'daytime', 'inflation' => 7,
];

$cases = [
    'defaults'        => $base,
    'daynight'        => ['tariff' => 'daynight', 'usage' => 'balanced'] + $base,
    'flux'            => ['tariff' => 'flux', 'usage' => 'evening'] + $base,
    'with_os_roi'     => ['os_roi' => 11.9] + $base,
    'flux_arbitrage'  => ['tariff' => 'flux', 'usage' => 'balanced', 'export_kwh' => 15000] + $base,
    'zero_battery'    => ['battery_kwh' => 0, 'inflation' => 10] + $base,
    'high_inflation'  => ['inflation' => 12, 'tariff' => 'daynight', 'usage' => 'evening', 'os_roi' => 8.5] + $base,
];

$out = [];
foreach ($cases as $name => $input) {
    $out[$name] = ['input' => $input, 'result' => $calc->calculate($input)];
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
