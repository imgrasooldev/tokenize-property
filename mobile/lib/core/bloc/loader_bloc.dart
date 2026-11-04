import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';

sealed class LoaderEvent extends Equatable {
  const LoaderEvent();
  @override
  List<Object?> get props => [];
}

/// First load, and pull-to-refresh.
final class LoadRequested extends LoaderEvent {
  const LoadRequested();
}

enum LoadStatus { loading, loaded, failure }

class LoaderState<T> extends Equatable {
  const LoaderState._(this.status, this.data, this.unauthorized);
  const LoaderState.loading([T? previous]) : this._(LoadStatus.loading, previous, false);
  const LoaderState.loaded(T data) : this._(LoadStatus.loaded, data, false);
  const LoaderState.failure({T? previous, bool unauthorized = false})
    : this._(LoadStatus.failure, previous, unauthorized);

  final LoadStatus status;

  /// The last data loaded (kept while refreshing or after a failure).
  final T? data;

  /// The API answered 401 after the refresh token was refused: sign in again.
  final bool unauthorized;

  @override
  List<Object?> get props => [status, data, unauthorized];
}

/// A screen's data from one repository call. Each feature's bloc is this with
/// its own repository method: presentation never talks to the API client.
class LoaderBloc<T> extends Bloc<LoaderEvent, LoaderState<T>> {
  LoaderBloc(Future<T> Function() load) : super(const LoaderState.loading()) {
    on<LoadRequested>((_, emit) async {
      emit(LoaderState.loading(state.data));
      try {
        emit(LoaderState.loaded(await load()));
      } on ApiException catch (e) {
        emit(LoaderState.failure(previous: state.data, unauthorized: e.unauthorized));
      }
    });
  }
}
