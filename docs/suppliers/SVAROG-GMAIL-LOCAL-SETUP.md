# Локальное подключение Gmail на Windows

Скрипт `ops/suppliers/svarog_gmail_authorize.py` предназначен для запуска самим владельцем на Windows, где открыт его обычный браузер. Python использует только стандартную библиотеку. Сервер, публичный callback, SSH-туннель и изменение VPN не требуются.

Скрипт получает отдельный readonly grant, проверяет ящик `bkush7430@gmail.com` через Gmail profile и сохраняет файл формата почтового моста. Он не читает сообщения, не включает расписание и не меняет товары.

## Что подготовить в Google

В проекте `masterweld-supplier-mail` должен быть включён Gmail API. Audience: External, scope — только `https://www.googleapis.com/auth/gmail.readonly`. Для первого теста аккаунт добавляется в Test users. Требуется создать клиент **Desktop app**, например «MasterWeld Supplier Mail Desktop». Это инструкция по завершению настройки, а не подтверждение уже созданного клиента или полученного grant.

Владелец сам завершает необходимые подтверждения Google, создаёт клиент и скачивает его JSON. Содержимое JSON и токены не пересылать в чат. Скрипт принимает официальный Desktop JSON с корнем `installed`; Web application client не подходит для этого локального сценария.

Для постоянной работы режим External/Testing не подходит: Google ограничивает такой refresh token семью днями. Завершение локального входа само по себе не подтверждает долгосрочную пригодность grant. [Срок refresh token](https://developers.google.com/identity/protocols/oauth2#expiration).

## Запуск владельцем

Нужен Python 3.10 или новее. Сохранить проверенный `svarog_gmail_authorize.py` и скачанный Google JSON на своём компьютере. В PowerShell, из каталога со скриптом:

```powershell
py -3 --version
py -3 .\svarog_gmail_authorize.py --client-config "$HOME\Downloads\client_secret_ИМЯ.json" --output "$env:LOCALAPPDATA\svarog-gmail.json"
```

В первой команде проверяется наличие Python. Во второй заменить только имя скачанного JSON на действительное. Целевой файл должен отсутствовать; каталог должен существовать. Использовать обычный локальный пользовательский каталог, не общую сетевую папку.

Откроется системный браузер. Выбрать `bkush7430@gmail.com`, проверить имя собственного приложения и подтвердить только чтение Gmail. Временный HTTP listener слушает исключительно `127.0.0.1` на случайном порту; после ответа или десяти минут ожидания он закрывается. Код авторизации не нужно копировать вручную.

Успех подтверждается сообщением «Подключение сохранено в указанном файле». Секреты, коды и callback URL не выводятся. При отмене, другом ящике, отсутствующем refresh token, лишних/неуказанных scopes или ошибке Google успешное сохранение не заявляется.

## Приватность и передача

На Windows файл создаётся через `CreateFileW(CREATE_NEW)` сразу с защищённым DACL только текущего пользователя. До записи токена проверяются фактические owner/DACL открытого файла и поддержка постоянных ACL томом. Использование `chmod` вместо Windows ACL не допускается. UNC, alternate data streams и reparse-каталоги отклоняются. Существующий файл не перезаписывается.

При ошибке записи может остаться защищённый пустой или неполный файл. Это не действующий результат подключения. Не отключать проверку ACL ради продолжения; сначала разобрать код ошибки. Повторный запуск не перезаписывает этот файл.

Владелец передаёт итоговый `svarog-gmail.json` на Linux через уже настроенный защищённый канал, например SFTP/WinSCP, без публикации или передачи в чат. Целевой канонический путь:

```text
/home/codex/projects/masterweld.ru/ops/.secrets/suppliers/svarog-gmail.json
```

Права Linux: каталог 0700, файл 0600, владелец — процесс почтового моста. Способ защищённой передачи и наличие Python на Windows ещё должны быть подтверждены владельцем. Сам bootstrap ничего на сервер не отправляет. Лишь после передачи и отдельной проверки выполняется ручной проход моста; расписание остаётся отдельным шагом.

## Проверка реализации

Есть синтетические проверки реального локального HTTP callback, state/PKCE, отказа поддельному callback, границ scope/ящика, endpoint/redaction, закрытия listener, сохранения в формате моста и запрета перезаписи. Windows ACL policy и отказ от небезопасного fallback проверены синтетически.

**Реальный Windows ABI/ACL и живой Google OAuth здесь не проверены.** Успешные Linux-тесты не заменяют первого пользовательского запуска на Windows.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s ops/suppliers -p test_svarog_gmail_authorize.py -v
```

Протокол: [Google Desktop OAuth с loopback и PKCE](https://developers.google.com/identity/protocols/oauth2/native-app). Windows: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).
