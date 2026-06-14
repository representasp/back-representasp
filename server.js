const express = require('express');
const axios = require('axios');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CONSTANTS = {
    SUB_KEY: 'd701a2043aa24d7ebb37e9adf60d043b',
    PRODUCT: 'SalaDoFuturo',
    BASE_SED: 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi',
    BASE_IPTV: 'https://edusp-api.ip.tv'
};

app.post('/api/consulta', async (req, res) => {
    const { user, senha } = req.body;

    console.log(`\n=== [BFF CALIBRAÇÃO] ALINHANDO INDICADORES PARA: ${user} ===`);

    try {
        // ----------------------------------------------------------
        // 1. LOGIN SED
        // ----------------------------------------------------------
        const loginRes = await axios.post(`${CONSTANTS.BASE_SED}/credenciais/api/LoginCompletoToken`,
            { user, senha },
            { headers: {
                'Content-Type': 'application/json',
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }}
        );

        const tokenSed = loginRes.data.token;
        const dadosUsuario = loginRes.data.DadosUsuario || {};
        const cdUsuario9 = dadosUsuario.CD_USUARIO?.toString();
        const cdUsuario8 = cdUsuario9 ? cdUsuario9.substring(0, 8) : '';
        const nomeCompletoAluno = dadosUsuario.NAME || 'Estudante';
        
        // RA Completo formatado para rotas específicas da SED que rejeitam o ID curto
        const raCompletoCompleto = `${cdUsuario8}${user.slice(-3)}`.toUpperCase();

        const cookiesRecebidos = loginRes.headers['set-cookie'] || [];
        const cookiesFiltrados = cookiesRecebidos.map(cookie => cookie.split(';')[0]).join('; ');

        const sedConfig = {
            headers: {
                'Authorization': `Bearer ${tokenSed}`,
                'X-Product-Name': CONSTANTS.PRODUCT,
                'Ocp-Apim-Subscription-Key': CONSTANTS.SUB_KEY,
                'Cookie': cookiesFiltrados,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Origin': 'https://saladofuturo.educacao.sp.gov.br',
                'Referer': 'https://saladofuturo.educacao.sp.gov.br/'
            }
        };

        // ----------------------------------------------------------
        // 2. BUSCAR TURMA (SED)
        // ----------------------------------------------------------
        let infoTurma = {};
        try {
            const turmaRes = await axios.get(
                `${CONSTANTS.BASE_SED}/apihubintegracoes/api/v2/Turma/ListarTurmasPorAluno?codigoAluno=${cdUsuario8}`, 
                sedConfig
            );
            if (Array.isArray(turmaRes.data)) {
                infoTurma = turmaRes.data[0];
            } else if (turmaRes.data?.data) {
                infoTurma = Array.isArray(turmaRes.data.data) ? turmaRes.data.data[0] : turmaRes.data.data;
            }
        } catch (errTurma) {
            console.error(`[BFF] Erro na rota de Turma: ${errTurma.message}`);
        }

        // ----------------------------------------------------------
        // 3. HANDSHAKE IP.TV
        // ----------------------------------------------------------
        let authTokenIptv = null;
        let nickAlunoLiteral = '';
        try {
            const iptvHandshake = await axios.post(`${CONSTANTS.BASE_IPTV}/registration/edusp/token`,
                { token: tokenSed },
                {
                    httpsAgent,
                    headers: {
                        'x-api-realm': 'edusp',
                        'x-api-platform': 'webclient',
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                }
            );
            
            authTokenIptv = iptvHandshake.data?.auth_token;
            nickAlunoLiteral = iptvHandshake.data?.nick || '';
            console.log(`[BFF] Nick retornado estritamente pelo servidor: ${nickAlunoLiteral}`);
        } catch (errIptv) {
            console.error(`[BFF] Erro no Handshake IPTV: ${errIptv.message}`);
        }

        // ----------------------------------------------------------
        // 4. BUSCAR AVALIAÇÕES (SED) - Ajustado Filtro de Escopo
        // ----------------------------------------------------------
        let totalAvaliacoes = 0;
        try {
            // Testamos com o ID de 8 dígitos padrão do Aluno
            const avalRes = await axios.get(`${CONSTANTS.BASE_SED}/apiboletim/api/Avaliacao/GetAvaliacaoAluno?AlunoId=${cdUsuario8}&AnoLetivo=2026`, sedConfig);
            const listaAvaliacoes = Array.isArray(avalRes.data) ? avalRes.data : (avalRes.data.data || []);
            totalAvaliacoes = listaAvaliacoes.length;
        } catch (errAval) {
            console.error(`[BFF] Erro na rota de avaliações: ${errAval.message}`);
        }

        // ----------------------------------------------------------
        // 5. FLUXO CALIBRADO DE TAREFAS E REDAÇÕES (IP.TV)
        // ----------------------------------------------------------
        let tarefasPendentes = 0;
        let tarefasExpiradas = 0;
        let totalRedacoes = 0;

        if (authTokenIptv) {
            try {
                const configIptvBase = {
                    httpsAgent,
                    headers: { 
                        'x-api-key': authTokenIptv, 
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0'
                    }
                };

                // Coleta de salas reais
                const roomsRes = await axios.get(`${CONSTANTS.BASE_IPTV}/room/user?list_all=true&with_cards=true`, configIptvBase);
                const rooms = roomsRes.data?.rooms || [];
                
                const targets = [];
                // Alinhamento preciso de targets usando a string crua enviada no log do app
                rooms.forEach(r => {
                    if (r.name) {
                        targets.push(`publication_target=${r.name}`);
                        if (nickAlunoLiteral) {
                            // O app oficial cruza a sala com o nick exato do handshake
                            targets.push(`publication_target=${r.name}:${nickAlunoLiteral}`);
                        }
                    }
                    if (Array.isArray(r.category_ids)) {
                        r.category_ids.forEach(id => targets.push(`publication_target=${id}`));
                    }
                });

                // Adiciona o canal geral se a lista estiver vazia
                if (targets.length === 0) targets.push('publication_target=all');
                
                const targetQuery = targets.join('&');

                // A. Busca Ampliada de Tarefas Pendentes (Garante o teto correto eliminando rascunhos fantasmas)
                try {
                    const urlPendentes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&filter_expired=true&with_answer=true&answer_statuses=pending&answer_statuses=draft`;
                    const pendentesRes = await axios.get(urlPendentes, configIptvBase);
                    const listaPendentes = Array.isArray(pendentesRes.data) ? pendentesRes.data : (pendentesRes.data?.data || []);
                    
                    // Filtragem de segurança: desconsidera o que já tiver status concluído/enviado escondido no array
                    tarefasPendentes = listaPendentes.filter(task => {
                        const status = task.answer?.status;
                        return status !== 'accepted' && status !== 'corrected' && status !== 'done';
                    }).length;

                } catch (ePend) { console.error(`[BFF] Falha ao ler pendentes calibrados: ${ePend.message}`); }

                // B. Busca Restrita de Tarefas Expiradas (Evita inflar com o histórico antigo de anos passados)
                try {
                    const urlExpiradas = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&expired_only=true&filter_expired=false&with_answer=true`;
                    const expiradasRes = await axios.get(urlExpiradas, configIptvBase);
                    const listaExpiradas = Array.isArray(expiradasRes.data) ? expiradasRes.data : (expiradasRes.data?.data || []);
                    
                    // Considera apenas as expiradas recentes que o aluno REALMENTE deixou de entregar (sem resposta aceita)
                    tarefasExpiradas = listaExpiradas.filter(task => !task.answer || task.answer.status === 'pending').length;
                } catch (eExp) { console.error(`[BFF] Falha ao ler expiradas calibradas: ${eExp.message}`); }

                // C. Busca de Redações Ativas
                try {
                    const urlRedacoes = `${CONSTANTS.BASE_IPTV}/tms/task/todo?${targetQuery}&is_essay=true&filter_expired=true&with_answer=true`;
                    const redacoesRes = await axios.get(urlRedacoes, configIptvBase);
                    const listaRedacoes = Array.isArray(redacoesRes.data) ? redacoesRes.data : (redacoesRes.data?.data || []);
                    totalRedacoes = listaRedacoes.length;
                } catch (eRed) { console.error(`[BFF] Falha ao ler redações calibradas: ${eRed.message}`); }

            } catch (errRooms) {
                console.error(`[BFF] Erro na estruturação fina das salas: ${errRooms.message}`);
            }
        }

        // ----------------------------------------------------------
        // RETORNO FORMATADO E EXPURGADO DE DADOS DUPLICADOS
        // ----------------------------------------------------------
        res.json({
            aluno: {
                nome: nomeCompletoAluno,
                codigo: raCompletoCompleto, 
                escola: infoTurma.NomeEscola || 'Não Informada',
                turma: infoTurma.DescricaoTurma || 'Não Informada'
            },
            indicadores: {
                pendentes: tarefasPendentes,
                expiradas: tarefasExpiradas,
                avaliacoes: totalAvaliacoes,
                redacoes: totalRedacoes
            }
        });

    } catch (error) {
        console.error(`[BFF] Erro Crítico Operacional: ${error.message}`);
        res.status(500).json({ error: "Erro interno na calibração de dados." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`BFF Produção Calibrado ativo na porta ${PORT}`));
