import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';
import 'package:property_token_app/l10n/gen/app_localizations.dart';

/// The code and link the investor opens on the website to confirm an app
/// request (ADR 0018 amendments 1 and 2), while the app polls for the answer.
class ConfirmOnWebsite extends StatelessWidget {
  const ConfirmOnWebsite({required this.request, super.key});

  final WebsiteConfirmation request;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final time = DateFormat.Hm(Localizations.localeOf(context).languageCode);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l.investWaiting, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 16),
        Text(l.investCode),
        SelectableText(
          request.code,
          key: const Key('invest-code'),
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 16),
        Text(l.investOpen),
        SelectableText(request.confirmUriComplete),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          icon: const Icon(Icons.copy),
          label: Text(l.investCopy),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: request.confirmUriComplete));
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l.investCopied)));
            }
          },
        ),
        const SizedBox(height: 16),
        Text(l.investConfirmBefore(time.format(request.expiresAt.toLocal()))),
        const SizedBox(height: 16),
        const LinearProgressIndicator(),
      ],
    );
  }
}
