import 'package:equatable/equatable.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

class Settings extends Equatable {
  const Settings({this.themeMode = ThemeMode.system, this.locale = const Locale('en')});

  /// Night Glass (dark) or Daylight (light); the phone's setting by default.
  final ThemeMode themeMode;

  /// English or Urdu (right to left).
  final Locale locale;

  @override
  List<Object?> get props => [themeMode, locale];
}

class SettingsCubit extends Cubit<Settings> {
  SettingsCubit([super.initial = const Settings()]);

  void setTheme(ThemeMode mode) => emit(Settings(themeMode: mode, locale: state.locale));

  void setLocale(Locale locale) => emit(Settings(themeMode: state.themeMode, locale: locale));
}
