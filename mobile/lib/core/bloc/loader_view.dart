import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// Loading, error with retry, pull-to-refresh and "sign in again" for any [LoaderBloc].
class LoaderView<B extends LoaderBloc<T>, T> extends StatelessWidget {
  const LoaderView({required this.builder, super.key});

  final Widget Function(BuildContext context, T data) builder;

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<B, LoaderState<T>>(
      listenWhen: (a, b) => b.unauthorized && !a.unauthorized,
      listener: (context, _) => context.read<AuthBloc>().add(const AuthExpired()),
      builder: (context, state) {
        final data = state.data;
        if (data != null) {
          return RefreshIndicator(
            onRefresh: () async {
              final bloc = context.read<B>()..add(const LoadRequested());
              await bloc.stream.firstWhere((s) => s.status != LoadStatus.loading);
            },
            child: builder(context, data),
          );
        }
        if (state.status == LoadStatus.failure) {
          final l = AppLocalizations.of(context);
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(l.errorGeneric),
                const SizedBox(height: 8),
                OutlinedButton(onPressed: () => context.read<B>().add(const LoadRequested()), child: Text(l.retry)),
              ],
            ),
          );
        }
        return const Center(child: CircularProgressIndicator());
      },
    );
  }
}
