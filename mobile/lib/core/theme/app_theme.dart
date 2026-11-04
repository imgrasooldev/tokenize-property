import 'package:flutter/material.dart';

/// The two looks of ADR 0018 (docs/design/app): Night Glass (dark, primary)
/// and a Daylight-style light theme. Colours only: no images or fonts, so the
/// second theme adds nothing noticeable to the app's size.
abstract final class AppTheme {
  // Night Glass (the website's own palette).
  static const _navy = Color(0xFF05070F);
  static const _panel = Color(0xFF0D1324);
  static const _cyan = Color(0xFF22E3F0);
  static const _violet = Color(0xFF8B5CF6);
  static const _mint = Color(0xFF2EF2B5);
  static const _rose = Color(0xFFF472B6);

  // Daylight.
  static const _paper = Color(0xFFF4F6FB);
  static const _ink = Color(0xFF0C1222);
  static const _dayViolet = Color(0xFF7C4DFF);
  static const _sky = Color(0xFF1FB8E0);
  static const _green = Color(0xFF0F9F66);

  static ThemeData get dark => _build(
    const ColorScheme.dark(
      primary: _cyan,
      onPrimary: _navy,
      secondary: _violet,
      tertiary: _mint,
      error: _rose,
      surface: _panel,
      onSurface: Color(0xFFE8ECF7),
    ),
    scaffold: _navy,
  );

  static ThemeData get light => _build(
    const ColorScheme.light(
      primary: _dayViolet,
      secondary: _sky,
      tertiary: _green,
      onSurface: _ink,
    ),
    scaffold: _paper,
  );

  static ThemeData _build(ColorScheme scheme, {required Color scaffold}) => ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: scaffold,
    useMaterial3: true,
    cardTheme: CardThemeData(
      color: scheme.surface,
      elevation: scheme.brightness == Brightness.dark ? 0 : 1,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: scheme.brightness == Brightness.dark
            ? BorderSide(color: scheme.primary.withValues(alpha: 0.18))
            : BorderSide.none,
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: scheme.brightness == Brightness.dark ? _panel : Colors.white,
      indicatorColor: scheme.primary.withValues(alpha: 0.2),
    ),
    appBarTheme: AppBarTheme(backgroundColor: scaffold, foregroundColor: scheme.onSurface, elevation: 0),
  );
}
