import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:intl/intl.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/features/inbox/presentation/inbox_bloc.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

class InboxPage extends StatelessWidget {
  const InboxPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.inboxTitle)),
      body: BlocConsumer<InboxBloc, InboxState>(
        listenWhen: (a, b) => b.unauthorized && !a.unauthorized,
        listener: (context, _) => context.read<AuthBloc>().add(const AuthExpired()),
        builder: (context, state) {
          if (state.items.isEmpty && state.loading) return const Center(child: CircularProgressIndicator());
          if (state.items.isEmpty && state.failed) {
            return Center(
              child: OutlinedButton(
                onPressed: () => context.read<InboxBloc>().add(const InboxRefreshed()),
                child: Text(l.retry),
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () async => context.read<InboxBloc>().add(const InboxRefreshed()),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (state.items.isEmpty) Text(l.inboxEmpty),
                for (final m in state.items)
                  Card(
                    child: ListTile(
                      key: Key('message-${m.id}'),
                      leading: Icon(m.read ? Icons.mark_email_read_outlined : Icons.mark_email_unread_rounded),
                      title: Text(m.title),
                      subtitle: Text(
                        '${DateFormat.yMMMd(lang).add_Hm().format(m.createdAt.toLocal())}\n${m.body}',
                        maxLines: 4,
                        overflow: TextOverflow.ellipsis,
                      ),
                      isThreeLine: true,
                    ),
                  ),
                if (state.hasMore)
                  TextButton(
                    key: const Key('inbox-more'),
                    onPressed: state.loading ? null : () => context.read<InboxBloc>().add(const InboxMoreRequested()),
                    child: Text(l.loadMore),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
