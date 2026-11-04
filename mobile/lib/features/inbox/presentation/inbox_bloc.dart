import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/inbox/domain/message.dart';

sealed class InboxEvent extends Equatable {
  const InboxEvent();
  @override
  List<Object?> get props => [];
}

final class InboxRefreshed extends InboxEvent {
  const InboxRefreshed();
}

final class InboxMoreRequested extends InboxEvent {
  const InboxMoreRequested();
}

class InboxState extends Equatable {
  const InboxState({
    this.items = const [],
    this.nextCursor,
    this.loading = true,
    this.failed = false,
    this.unauthorized = false,
  });

  final List<Message> items;
  final String? nextCursor;
  final bool loading;
  final bool failed;
  final bool unauthorized;

  bool get hasMore => nextCursor != null;

  InboxState copyWith({
    List<Message>? items,
    String? Function()? nextCursor,
    bool? loading,
    bool? failed,
    bool? unauthorized,
  }) => InboxState(
    items: items ?? this.items,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    failed: failed ?? this.failed,
    unauthorized: unauthorized ?? this.unauthorized,
  );

  @override
  List<Object?> get props => [items, nextCursor, loading, failed, unauthorized];
}

/// The inbox with keyset pagination: a refresh starts over, "load more" appends the next page.
class InboxBloc extends Bloc<InboxEvent, InboxState> {
  InboxBloc(this._repo) : super(const InboxState()) {
    on<InboxRefreshed>((_, emit) => _load(emit, append: false));
    on<InboxMoreRequested>((_, emit) async {
      if (state.loading || !state.hasMore) return;
      await _load(emit, append: true);
    });
  }

  final InboxRepository _repo;

  Future<void> _load(Emitter<InboxState> emit, {required bool append}) async {
    emit(state.copyWith(loading: true, failed: false));
    try {
      final p = await _repo.page(cursor: append ? state.nextCursor : null);
      emit(
        InboxState(items: append ? [...state.items, ...p.items] : p.items, nextCursor: p.nextCursor, loading: false),
      );
    } on ApiException catch (e) {
      emit(state.copyWith(loading: false, failed: true, unauthorized: e.unauthorized));
    }
  }
}
