import 'package:intl/intl.dart';

/// Money from the API: integer minor units (paisa) as a string, ISO 4217
/// currency (ADR 0018). Never floats: rupees and paisa are split as integers.
String formatPkr(String paisa, String locale) {
  final v = BigInt.parse(paisa);
  final neg = v.isNegative;
  final abs = v.abs();
  final rupees = NumberFormat.decimalPattern(
    locale == 'ur' ? 'ur_PK' : 'en_PK',
  ).format((abs ~/ BigInt.from(100)).toInt());
  final cents = (abs % BigInt.from(100)).toString().padLeft(2, '0');
  return '${neg ? '-' : ''}Rs $rupees.$cents';
}

/// Whole token units (decimal string) with grouping.
String formatUnits(String units, String locale) =>
    NumberFormat.decimalPattern(locale == 'ur' ? 'ur_PK' : 'en_PK').format(BigInt.parse(units).toInt());
