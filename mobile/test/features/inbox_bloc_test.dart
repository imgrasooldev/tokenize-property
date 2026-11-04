import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/inbox/domain/message.dart';
import 'package:property_token_app/features/inbox/presentation/inbox_bloc.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';
import 'package:property_token_app/features/portfolio/presentation/portfolio_bloc.dart';

class _MockInbox extends Mock implements InboxRepository {}

class _MockPortfolio extends Mock implements PortfolioRepository {}

Message _m(String id) => Message(id: id, title: 't$id', body: '', createdAt: DateTime.utc(2026), read: false);

void main() {
  blocTest<InboxBloc, InboxState>(
    'refresh loads the first page; more appends the next one with its cursor',
    build: () {
      final repo = _MockInbox();
      when(repo.page).thenAnswer((_) async => MessagePage([_m('3'), _m('2')], 'c1'));
      when(() => repo.page(cursor: 'c1')).thenAnswer((_) async => MessagePage([_m('1')], null));
      return InboxBloc(repo);
    },
    act: (b) async {
      b.add(const InboxRefreshed());
      await Future<void>.delayed(Duration.zero);
      b.add(const InboxMoreRequested());
    },
    skip: 2,
    expect: () => [
      InboxState(items: [_m('3'), _m('2')], nextCursor: 'c1'),
      InboxState(items: [_m('3'), _m('2'), _m('1')], loading: false),
    ],
  );

  blocTest<InboxBloc, InboxState>(
    'a 401 marks the state unauthorized (the app then signs in again)',
    build: () {
      final repo = _MockInbox();
      when(repo.page).thenThrow(const ApiException(401, 'invalid_token'));
      return InboxBloc(repo);
    },
    act: (b) => b.add(const InboxRefreshed()),
    expect: () => [const InboxState(), const InboxState(loading: false, failed: true, unauthorized: true)],
  );

  blocTest<PortfolioBloc, LoaderState<Portfolio>>(
    'a failed refresh keeps the last portfolio on screen',
    build: () {
      final repo = _MockPortfolio();
      var n = 0;
      when(repo.portfolio).thenAnswer((_) async {
        if (n++ > 0) throw const ApiException(0, 'unreachable');
        return const Portfolio(holdings: [], subscriptions: [], asOfBlock: '10');
      });
      return PortfolioBloc(repo);
    },
    act: (b) async {
      b.add(const LoadRequested());
      await Future<void>.delayed(Duration.zero);
      b.add(const LoadRequested());
    },
    expect: () => const [
      LoaderState<Portfolio>.loading(),
      LoaderState<Portfolio>.loaded(Portfolio(holdings: [], subscriptions: [], asOfBlock: '10')),
      LoaderState<Portfolio>.loading(Portfolio(holdings: [], subscriptions: [], asOfBlock: '10')),
      LoaderState<Portfolio>.failure(
        previous: Portfolio(holdings: [], subscriptions: [], asOfBlock: '10'),
      ),
    ],
  );
}
